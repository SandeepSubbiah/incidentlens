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
export type ChangeState = 'awaiting_approval' | 'completed' | 'failed' | 'denied' | 'vetoed' | 'expired';
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

async function load(): Promise<ChangeRequest[]> {
  return JSON.parse(await readFile(file(), 'utf8').catch(() => '[]'));
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

export async function setKillSwitch(on: boolean, actor: Actor, reason: string) {
  if (actor.role !== 'admin') throw new GovernanceError('R-ROLE', 'only an admin can change the kill switch');
  await mkdir(path.dirname(killFile()), { recursive: true });
  const state = { on, by: actor.sub, at: new Date().toISOString(), reason };
  await writeFile(killFile(), JSON.stringify(state));
  await audit().append(actor.sub, on ? 'governance.kill.on' : 'governance.kill.off', 'kill-switch', { reason });
  return state;
}

export async function listChanges(limit = 30): Promise<ChangeRequest[]> {
  return (await load()).slice(-limit).reverse();
}

export async function getChange(id: string): Promise<ChangeRequest | undefined> {
  return (await load()).find((c) => c.id === id);
}

async function execute(cr: ChangeRequest, approver: string): Promise<void> {
  try {
    if (cr.kind === 'skill-change') {
      const reg = await getRegistry();
      const p = cr.payload as { skill: string; content: string; rationale: string };
      const v = await reg.addVersion(p.skill, p.content, cr.requester, p.rationale);
      await reg.activate(p.skill, v, `human:${approver}`, `approved ${cr.id}`);
      cr.result = { skill: p.skill, version: v };
    } else if (cr.kind === 'skill-rollback') {
      const reg = await getRegistry();
      const p = cr.payload as { skill: string; reason: string };
      const to = await reg.rollback(p.skill, cr.requester, p.reason);
      cr.result = { skill: p.skill, version: to };
    } else {
      const p = cr.payload as { incident: string; artifact: string; patch: string };
      cr.result = { mode: 'simulated', note: 'applied to an isolated copy of the artifact; no real system was touched', ...(await sandboxApply(p.incident, p)) };
    }
    cr.state = cr.kind === 'remediation' && cr.result.status === 'failed' ? 'failed' : 'completed';
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
    const cr: ChangeRequest = {
      id: `CR-${now.getTime().toString(36)}-${randomBytes(2).toString('hex')}`,
      kind: input.kind,
      title: input.title,
      requester: input.requester,
      risk: input.risk,
      target: input.target,
      payload: input.payload,
      hash: changeHash(input.kind, input.target, input.payload),
      policy_version: POLICY.version,
      evidence: input.evidence ?? [],
      required_approvals: POLICY.approvals[input.risk],
      execution: input.kind === 'remediation' ? 'simulated' : 'live',
      decisions: [],
      state: 'awaiting_approval',
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + POLICY.ttl_minutes[input.risk] * 60_000).toISOString(),
    };
    const all = await load();
    await audit().append(input.requester, 'change.proposed', cr.id, { kind: cr.kind, risk: cr.risk, target: cr.target, hash: cr.hash });
    if (input.risk === 'A4') {
      cr.state = 'denied';
      cr.rule = 'R-A4: privileged or irreversible actions are prohibited by policy';
    } else if (POLICY.preauthorized.includes(input.kind)) {
      cr.decisions.push({ actor: 'policy', role: 'policy', decision: 'approve', reason: `pre-authorized by ${POLICY.version}`, hash: cr.hash, at: now.toISOString() });
      cr.rule = 'R-PREAUTH: restoring a previously validated version is pre-authorized';
      if ((await killSwitch()).on && input.kind !== 'skill-rollback') cr.rule = 'R1: kill switch is on';
      else await execute(cr, 'policy');
    }
    all.push(cr);
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
        await execute(cr, actor.sub);
      } else {
        cr.rule = `R6: ${approvers.size} of ${cr.required_approvals} required approvals; waiting for a different approver`;
      }
    }
    await save(all);
    return cr;
  });
}
