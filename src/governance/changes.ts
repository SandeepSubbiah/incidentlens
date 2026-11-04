import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { auditLogAt } from '../guard/audit.ts';
import { dataDir } from '../paths.ts';
import { sandboxApply } from '../sandbox.ts';
import { getRegistry } from '../skills/registry.ts';

// The control plane. Agents and the doctor may only *propose* changes; this module decides,
// in code, whether a proposal may run. Approval binds to the SHA-256 of the exact change, the
// requester can never approve its own request, a veto or expiry always wins over approvals, a
// kill switch stops everything except rollbacks, and an authorized change executes once.

export type Risk = 'A0' | 'A1' | 'A2' | 'A3' | 'A4';
export type ChangeKind = 'skill-change' | 'skill-rollback' | 'remediation';
// executing: the start of execution is recorded before anything runs (write-ahead).
// rolled_back: execution failed after a partial commit and the previous state was restored.
// recovery_incomplete: execution was interrupted or its compensation failed; needs a human.
export type ChangeState = 'awaiting_approval' | 'executing' | 'completed' | 'failed' | 'rolled_back' | 'recovery_incomplete' | 'denied' | 'vetoed' | 'expired';
export type DecisionKind = 'approve' | 'reject' | 'veto';

export interface Actor {
  sub: string;
  role: string;
}

export interface Decision {
  actor: string;
  role: string;
  decision: DecisionKind;
  reason: string;
  hash: string;
  at: string;
}

export interface ChangeRequest {
  id: string;
  kind: ChangeKind;
  title: string;
  requester: string;
  risk: Risk;
  target: string;
  payload: Record<string, unknown>;
  hash: string;
  policy_version: string;
  evidence: string[];
  required_approvals: number;
  // Code remediations never touch a real system: they are applied to an isolated copy.
  execution: 'live' | 'simulated';
  decisions: Decision[];
  // Open requests for the same target at proposal time.
  conflicts: string[];
  state: ChangeState;
  rule?: string;
  created_at: string;
  expires_at: string;
  executed_at?: string;
  result?: Record<string, unknown>;
}

export const POLICY = {
  version: 'policy-2026-11-04.1',
  approvals: { A0: 0, A1: 1, A2: 1, A3: 2, A4: Infinity } as Record<Risk, number>,
  ttl_minutes: { A0: 60, A1: 240, A2: 240, A3: 120, A4: 0 } as Record<Risk, number>,
  approver_roles: ['admin'],
  stop_roles: ['admin', 'judge'],
  // Restoring a previously active, previously validated skill version is pre-authorized.
  preauthorized: ['skill-rollback'] as ChangeKind[],
};

export class GovernanceError extends Error {
  rule: string;
  constructor(rule: string, message: string) {
    super(`${rule}: ${message}`);
    this.rule = rule;
  }
}

const file = () => path.join(dataDir(), 'governance', 'changes.json');
const killFile = () => path.join(dataDir(), 'governance', 'kill-switch.json');
const audit = () => auditLogAt(path.join(dataDir(), 'audit.jsonl'));

let tail: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = tail.then(fn);
  tail = next.catch(() => {});
  return next;
}

let recovered = false;

async function load(): Promise<ChangeRequest[]> {
  const all: ChangeRequest[] = JSON.parse(await readFile(file(), 'utf8').catch(() => '[]'));
  // A request still marked "executing" when a process starts was interrupted mid-execution.
  // It is never re-run automatically: its side effects may have partly happened.
  if (!recovered) {
    recovered = true;
    const interrupted = all.filter((c) => c.state === 'executing');
    for (const c of interrupted) {
      c.state = 'recovery_incomplete';
      c.rule = 'R8: execution was interrupted by a restart; it was not re-run; verify the target and resolve manually';
      await audit().append('governance', 'change.recovery_incomplete', c.id, { reason: 'interrupted execution found at startup' });
    }
    if (interrupted.length) await save(all);
  }
  return all;
}

async function save(all: ChangeRequest[]) {
  await mkdir(path.dirname(file()), { recursive: true });
  await writeFile(file() + '.tmp', JSON.stringify(all, null, 2));
  await rename(file() + '.tmp', file());
}

export function changeHash(kind: ChangeKind, target: string, payload: unknown): string {
  return createHash('sha256').update(JSON.stringify([kind, target, payload])).digest('hex');
}

export async function killSwitch(): Promise<{ on: boolean; by?: string; at?: string; reason?: string }> {
  return JSON.parse(await readFile(killFile(), 'utf8').catch(() => '{"on":false}'));
}

// Serialized with decisions, so a switch that lands while an approval is executing takes
// effect after it, and every later decision sees it.
export async function setKillSwitch(on: boolean, actor: Actor, reason: string) {
  if (actor.role !== 'admin') throw new GovernanceError('R-ROLE', 'only an admin can change the kill switch');
  return exclusive(async () => {
    await mkdir(path.dirname(killFile()), { recursive: true });
    const state = { on, by: actor.sub, at: new Date().toISOString(), reason };
    await writeFile(killFile(), JSON.stringify(state));
    await audit().append(actor.sub, on ? 'governance.kill.on' : 'governance.kill.off', 'kill-switch', { reason });
    return state;
  });
}

export async function listChanges(limit = 30): Promise<ChangeRequest[]> {
  return (await load()).slice(-limit).reverse();
}

export async function getChange(id: string): Promise<ChangeRequest | undefined> {
  return (await load()).find((c) => c.id === id);
}

async function executeSkillChange(cr: ChangeRequest, approver: string): Promise<void> {
  const reg = await getRegistry();
  const p = cr.payload as { skill: string; content: string; rationale: string; base_version?: number };
  const before = reg.view().get(p.skill)?.version;
  // Optimistic concurrency: the change was built on base_version; if that is no longer live,
  // applying it would silently discard whatever changed in between.
  if (p.base_version !== undefined && before !== p.base_version) {
    cr.state = 'denied';
    cr.rule = `R7: ${p.skill} changed since this request was made (built on v${p.base_version}, live is v${before}); propose again against the live version`;
    cr.result = { conflict: { base_version: p.base_version, live_version: before } };
    return;
  }
  let added: number | undefined;
  try {
    added = await reg.addVersion(p.skill, p.content, cr.requester, p.rationale);
    await reg.activate(p.skill, added, `human:${approver}`, `approved ${cr.id}`);
    const live = reg.view().get(p.skill)?.version;
    if (live !== added) throw new Error(`postcondition failed: v${live} is live, expected v${added}`);
    cr.state = 'completed';
    cr.result = { skill: p.skill, version: added };
  } catch (err: any) {
    const live = reg.view().get(p.skill)?.version;
    if (live === before) {
      // Failed before the commit point: an added version, if any, is stored but inert.
      cr.state = 'failed';
      cr.result = { error: err.message, live_version: live, inert_version: added ?? null };
      return;
    }
    // Failed after the commit point: restore what was live before.
    try {
      await reg.activate(p.skill, before!, 'governance:compensation', `restore after failed ${cr.id}`);
      cr.state = 'rolled_back';
      cr.rule = `R9: execution failed after a partial commit (${err.message}); restored v${before}`;
      cr.result = { error: err.message, restored_version: before };
    } catch (compensationErr: any) {
      cr.state = 'recovery_incomplete';
      cr.rule = `R9: execution failed after a partial commit and restoring v${before} also failed; v${live} is live; needs a human`;
      cr.result = { error: err.message, compensation_error: compensationErr.message, live_version: live };
    }
  }
}

async function execute(cr: ChangeRequest, approver: string): Promise<void> {
  try {
    if (cr.kind === 'skill-change') {
      await executeSkillChange(cr, approver);
    } else if (cr.kind === 'skill-rollback') {
      const reg = await getRegistry();
      const p = cr.payload as { skill: string; reason: string };
      const to = await reg.rollback(p.skill, cr.requester, p.reason);
      cr.result = { skill: p.skill, version: to };
    } else {
      const p = cr.payload as { incident: string; artifact: string; patch: string };
      cr.result = { mode: 'simulated', note: 'applied to an isolated copy of the artifact; no real system was touched', ...(await sandboxApply(p.incident, p)) };
    }
    if (cr.kind !== 'skill-change') cr.state = cr.kind === 'remediation' && cr.result!.status === 'failed' ? 'failed' : 'completed';
  } catch (err: any) {
    cr.state = 'failed';
    cr.result = { error: err.message };
  }
  cr.executed_at = new Date().toISOString();
  await audit().append(approver, `change.${cr.state}`, cr.id, { kind: cr.kind, target: cr.target, hash: cr.hash, result: cr.result });
}

export async function propose(input: { kind: ChangeKind; title: string; requester: string; risk: Risk; target: string; payload: Record<string, unknown>; evidence?: string[]; now?: Date }): Promise<ChangeRequest> {
  return exclusive(async () => {
    const now = input.now ?? new Date();
    const payload = { ...input.payload };
    if (input.kind === 'skill-change' && payload.base_version === undefined) {
      payload.base_version = (await getRegistry()).view().get(String(payload.skill))?.version;
    }
    const open = (await load()).filter((c) => c.target === input.target && (c.state === 'awaiting_approval' || c.state === 'executing'));
    const cr: ChangeRequest = {
      id: `CR-${now.getTime().toString(36)}-${randomBytes(2).toString('hex')}`,
      kind: input.kind,
      title: input.title,
      requester: input.requester,
      risk: input.risk,
      target: input.target,
      payload,
      hash: changeHash(input.kind, input.target, payload),
      policy_version: POLICY.version,
      evidence: input.evidence ?? [],
      required_approvals: POLICY.approvals[input.risk],
      execution: input.kind === 'remediation' ? 'simulated' : 'live',
      decisions: [],
      conflicts: open.map((c) => c.id),
      state: 'awaiting_approval',
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + POLICY.ttl_minutes[input.risk] * 60_000).toISOString(),
    };
    const all = await load();
    all.push(cr);
    await audit().append(input.requester, 'change.proposed', cr.id, { kind: cr.kind, risk: cr.risk, target: cr.target, hash: cr.hash });
    if (input.risk === 'A4') {
      cr.state = 'denied';
      cr.rule = 'R-A4: privileged or irreversible actions are prohibited by policy';
    } else if (POLICY.preauthorized.includes(input.kind)) {
      // Pre-authorized kinds are rollbacks, which stay allowed under the kill switch.
      cr.decisions.push({ actor: 'policy', role: 'policy', decision: 'approve', reason: `pre-authorized by ${POLICY.version}`, hash: cr.hash, at: now.toISOString() });
      cr.rule = 'R-PREAUTH: restoring a previously validated version is pre-authorized';
      cr.state = 'executing';
      await save(all); // write-ahead, as for approved changes
      await execute(cr, 'policy');
    }
    await save(all);
    return cr;
  });
}

// Precedence: kill switch, then veto/reject, then expiry, then hash binding, role and
// separation of duties, then quorum. Earlier rules win regardless of later ones.
export async function decide(id: string, actor: Actor, decision: DecisionKind, reason: string, hash: string, now = new Date()): Promise<ChangeRequest> {
  return exclusive(async () => {
    const all = await load();
    const cr = all.find((c) => c.id === id);
    if (!cr) throw new GovernanceError('R-404', `no change request ${id}`);
    if (cr.state !== 'awaiting_approval') throw new GovernanceError('R-FINAL', `${id} is already ${cr.state}`);
    const deny = async (rule: string, message: string): Promise<never> => {
      await audit().append(actor.sub, 'change.decision.refused', id, { decision, rule, message });
      throw new GovernanceError(rule, message);
    };
    if (decision === 'approve' && (await killSwitch()).on) await deny('R1', 'kill switch is on; no changes may execute');
    if (Date.parse(cr.expires_at) <= now.getTime()) {
      cr.state = 'expired';
      cr.rule = 'R3: approval window expired; expiry fails closed';
      await save(all);
      await audit().append('policy', 'change.expired', id, {});
      await deny('R3', `${id} expired at ${cr.expires_at}`);
    }
    if (hash !== cr.hash) await deny('R4', 'the change differs from the one you reviewed (hash mismatch); review it again');
    const roles = decision === 'approve' ? POLICY.approver_roles : POLICY.stop_roles;
    if (!roles.includes(actor.role)) await deny('R-ROLE', `role ${actor.role} cannot ${decision}`);
    if (decision === 'approve' && actor.sub === cr.requester) await deny('R5', 'the requester cannot approve its own change');
    if (decision === 'approve' && cr.decisions.some((d) => d.actor === actor.sub && d.decision === 'approve')) await deny('R5', `${actor.sub} has already approved; a second, different approver is required`);

    cr.decisions.push({ actor: actor.sub, role: actor.role, decision, reason, hash, at: now.toISOString() });
    await audit().append(actor.sub, `change.${decision}`, id, { reason, hash });
    if (decision === 'veto' || decision === 'reject') {
      cr.state = decision === 'veto' ? 'vetoed' : 'denied';
      cr.rule = decision === 'veto' ? 'R2: vetoed; no later approval can revive it' : 'R2: rejected by a reviewer';
    } else {
      const approvers = new Set(cr.decisions.filter((d) => d.decision === 'approve' && d.actor !== cr.requester).map((d) => d.actor));
      if (approvers.size >= cr.required_approvals) {
        cr.rule = `R6: ${approvers.size} of ${cr.required_approvals} required approvals`;
        // Write-ahead: record that execution started before anything runs, so a crash
        // mid-execution is detected at the next start instead of being re-run.
        cr.state = 'executing';
        await save(all);
        await execute(cr, actor.sub);
      } else {
        cr.rule = `R6: ${approvers.size} of ${cr.required_approvals} required approvals; waiting for a different approver`;
      }
    }
    await save(all);
    return cr;
  });
}
