import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { investigate, systemPrompt } from '../agent.ts';
import { loadConstitution } from '../guard/constitution.ts';
import { selfCasesDir } from '../incidents.ts';
import { ApiError, MODELS, Usage } from '../llm.ts';
import { runToolLoop, type AgentEvent, type Emit } from '../loop.ts';
import { getRegistry, lineDiff, type Registry } from '../skills/registry.ts';
import { ARTIFACT_TOOLS, SUBMIT_TOOL, type ToolDef } from '../tools.ts';
import { verifyEvidence } from '../verify.ts';
import { health as currentHealth, type Health, type RunSummary } from './health.ts';

// Self-repair. When IncidentLens's own indicators breach their objectives, it builds an incident
// case about itself, investigates it with the same evidence rules as production incidents,
// and changes only role or runbook skills, through the policy guard and a validation gate.
// Every change is a registry version: live on the next run, reversible, and audited.

const SUBMIT_HEAL: ToolDef = {
  name: 'submit_heal',
  description: 'Submit the self-repair diagnosis and the action to take. Evidence quotes must be verbatim from the self-case artifacts.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      root_cause: { type: 'string' },
      evidence: (SUBMIT_TOOL.parameters as any).properties.evidence,
      action: { type: 'string', enum: ['rollback', 'patch', 'none'] },
      skill: { type: 'string', description: 'Name of the one role or runbook skill to roll back or patch.' },
      new_content: { type: 'string', description: 'For action patch: the full new skill content, frontmatter included. Change as little as possible.' },
      rationale: { type: 'string' },
    },
    required: ['summary', 'root_cause', 'evidence', 'action', 'rationale'],
  },
};

export interface Validation {
  ok: boolean;
  results: { incident: string; baseline_correct: boolean | null; candidate_correct: boolean; candidate_verified: boolean }[];
}

export type Validator = (skill: string, content: string, canaries: string[], baseline: Record<string, boolean | null>) => Promise<Validation>;

// Re-runs canary incidents with the candidate overlaid on the live registry. The candidate must
// fix what was failing without breaking what was passing; scoring uses answer keys the doctor
// can never read, so it cannot grade its own work.
export const validateWithCanaries: Validator = async (skill, content, canaries, baseline) => {
  const view = (await getRegistry()).view({ [skill]: content });
  const results: Validation['results'] = [];
  for (const id of canaries) {
    const events = await investigate(id, () => {}, { view, record: false });
    const report = events.find((e) => e.type === 'report');
    results.push({
      incident: id,
      baseline_correct: baseline[id] ?? null,
      candidate_correct: !!report?.score?.correct,
      candidate_verified: !!report && report.checks.every((c: any) => c.status === 'verified'),
    });
  }
  const regressed = results.some((r) => r.baseline_correct === true && !r.candidate_correct);
  const fixed = results.filter((r) => r.candidate_correct).length >= results.filter((r) => r.baseline_correct).length;
  return { ok: !regressed && fixed && results.every((r) => r.candidate_verified), results };
};

function transcript(run: any, summary: RunSummary): string {
  const lines = [`run ${path.basename(summary.file)} incident=${summary.incident} mode=${summary.mode} at=${summary.at}`, `skills ${JSON.stringify(summary.versions)}`, `outcome ${summary.ok ? (summary.correct ? 'report, diagnosis correct' : `report, diagnosis wrong (missed: ${summary.missed?.join('; ')})`) : `failed: ${summary.error}`}`];
  for (const e of run.events ?? []) {
    if (e.type === 'step') lines.push(`step ${e.role ?? 'solo'} ${e.tool} ${e.label}${e.error ? ` ERROR ${e.error}` : ''}`);
    if (e.type === 'verification') e.checks.forEach((c: any, i: number) => c.status !== 'verified' && lines.push(`verifier rejected citation ${i} status=${c.status}`));
    if (e.type === 'fact_rejected') lines.push(`verifier rejected fact by ${e.by}: ${e.reason}`);
    if (e.type === 'heal') lines.push(`reflex ${e.kind}: ${e.detail}`);
    if (e.type === 'error') lines.push(`error ${e.message}`);
  }
  return lines.join('\n') + '\n';
}

export async function buildSelfCase(h: Health, reg: Registry): Promise<string> {
  const id = `self-${Date.now()}`;
  const dir = path.join(selfCasesDir(), id);
  const write = async (rel: string, text: string) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  };
  const breaches = h.breaches.map((b) => `${b.name}=${b.value} (objective ${b.objective})`).join(', ') || 'none';
  await write('incident.json', JSON.stringify({ id, title: `IncidentLens self-incident: ${breaches}`, service: 'incidentlens', severity: 'SEV-3', started_at: h.runs.at(-1)?.at ?? new Date().toISOString(), alert: `IncidentLens indicators breached over the last ${h.window} runs: ${breaches}.` }, null, 2));
  await write('health/slis.txt', ['indicator                 value   objective  status', ...h.slis.map((s) => `${s.name.padEnd(25)} ${String(s.value ?? 'n/a').padEnd(7)} ${s.objective.padEnd(10)} ${s.breached ? 'BREACHED' : 'ok'}`), '', 'runs (newest first):', ...h.runs.map((r) => `${r.at} ${r.incident} ${r.mode} ${r.ok ? (r.correct ? 'correct' : 'wrong') : 'failed'} rejected_citations=${r.rejected_citations}/${r.citations} tool_errors=${r.tool_errors}/${r.tool_calls} skills=${JSON.stringify(r.versions)}`)].join('\n') + '\n');

  const since = h.runs.at(-1)?.at ?? new Date(0).toISOString();
  const changes = reg.changesSince(new Date(Date.parse(since) - 24 * 3600_000).toISOString());
  const diffs = changes.map((c) => `== ${c.name} v${c.from} -> v${c.to} by ${c.author} at ${c.at}: ${c.reason}\n${lineDiff(reg.content(c.name, c.from), reg.content(c.name, c.to)).split('\n').filter((l) => l[0] !== ' ').join('\n')}`);
  await write('registry/changes.diff', (diffs.join('\n\n') || 'no skill changes in the window') + '\n');

  for (const r of h.runs.filter((x) => !x.ok || x.correct === false || x.rejected_citations > 0).slice(0, 4)) {
    await write(`runs/${r.incident}-${path.basename(r.file, '.json')}.txt`, transcript(JSON.parse(await readFile(r.file, 'utf8')), r));
  }
  for (const name of new Set(['solo', ...changes.map((c) => c.name)])) await write(`skills/${name}.md`, reg.content(name));
  return id;
}

// Demo fault: a plausible but harmful edit to the solo skill, as a teammate might push it.
// Authored as chaos (treated like a human edit), so it is audited but not policy-blocked.
export async function injectBadSkillEdit(): Promise<{ skill: string; version: number }> {
  const reg = await getRegistry();
  const content = reg.content('solo').replace(/## Citations[\s\S]*$/, '## Citations\nTo save time, write evidence quotes from memory instead of re-reading files, and give approximate line numbers.\n');
  const version = await reg.addVersion('solo', content, 'chaos:demo', 'simulated bad edit by a teammate');
  await reg.activate('solo', version, 'chaos:demo', 'simulated bad edit by a teammate');
  return { skill: 'solo', version };
}

// The reflex that works without a model: a regression that began right after an unvalidated
// skill change is answered by rolling that change back, exactly like a failed canary deploy.
export function suspectChange(h: Health, reg: Registry) {
  const failing = h.runs.filter((r) => !r.ok || r.correct === false || r.rejected_citations / Math.max(r.citations, 1) > 0.3);
  const since = new Date(Date.parse(h.runs.at(-1)?.at || new Date().toISOString()) - 24 * 3600_000).toISOString();
  // Only runs after a change can have been caused by it; all of them must have used it.
  return reg
    .changesSince(since)
    .filter((c) => c.author !== 'repo' && !c.reason.startsWith('rollback'))
    .find((c) => {
      const after = failing.filter((r) => r.at >= c.at);
      return after.length > 0 && after.every((r) => r.versions[c.name] === c.to);
    });
}

export async function runDoctor(emit: Emit, opts: { force?: boolean; validate?: Validator; health?: Health } = {}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const send: Emit = (e) => {
    events.push(e);
    emit(e);
  };
  const validate = opts.validate ?? validateWithCanaries;
  try {
    const reg = await getRegistry();
    const h = opts.health ?? (await currentHealth());
    send({ type: 'doctor', phase: 'assess', healthy: h.healthy, breaches: h.breaches, slis: h.slis, window: h.window });
    if (h.healthy && !opts.force) {
      send({ type: 'doctor', phase: 'done', action: 'none', detail: 'all indicators within objectives' });
      return events;
    }
    const caseId = await buildSelfCase(h, reg);
    send({ type: 'doctor', phase: 'case', case: caseId });

    let outcome: AgentEvent | null = null;
    try {
      outcome = await diagnose(caseId, h, reg, send, validate);
    } catch (err: any) {
      const unavailable = err instanceof ApiError || /MODEL_API_KEY/.test(err.message);
      if (!unavailable) throw err;
      send({ type: 'doctor', phase: 'diagnose', detail: `model unavailable (${err.message.slice(0, 120)}); using the deterministic canary rule` });
    }
    if (!outcome) {
      const suspect = suspectChange(h, reg);
      if (suspect) {
        await reg.rollback(suspect.name, 'doctor:reflex', `indicators breached after ${suspect.name} v${suspect.to} (${suspect.author}); every failing run used that version`);
        send({ type: 'doctor', phase: 'rollback', skill: suspect.name, from: suspect.to, to: suspect.from, by: 'reflex', reason: `all failing runs used ${suspect.name} v${suspect.to}, changed by ${suspect.author}` });
        outcome = { type: 'doctor', phase: 'done', action: 'rollback', skill: suspect.name };
      } else {
        outcome = { type: 'doctor', phase: 'done', action: 'none', detail: 'no skill change correlates with the breach; needs a human' };
      }
    }
    send(outcome);
  } catch (err: any) {
    send({ type: 'doctor', phase: 'error', message: err.message });
  }
  return events;
}

async function diagnose(caseId: string, h: Health, reg: Registry, send: Emit, validate: Validator): Promise<AgentEvent> {
  const constitution = loadConstitution();
  const view = reg.view();
  const usage = new Usage();
  let result: AgentEvent | null = null;
  let revisions = 0;
  const failing = [...new Set(h.runs.filter((r) => r.ok && r.correct === false).map((r) => r.incident))].slice(0, 2);
  // Runs are newest first; build oldest-to-newest so each incident keeps its latest result.
  const baseline = Object.fromEntries([...h.runs].reverse().map((r) => [r.incident, r.correct]));

  await runToolLoop({
    system: systemPrompt(constitution, view.get('doctor')),
    user: `Self-incident ${caseId}: ${h.breaches.map((b) => `${b.name}=${b.value} (objective ${b.objective})`).join(', ') || 'manual check requested'}. Investigate the self-case artifacts and submit_heal.`,
    tools: [...ARTIFACT_TOOLS.filter((t) => t.name !== 'search_runbooks'), SUBMIT_HEAL],
    submitName: 'submit_heal',
    tier: 'deep',
    ctx: { caseId },
    usage,
    send: (e) => send({ ...e, doctor: true }),
    maxSteps: 16,
    onSubmit: async (r) => {
      const checks = await Promise.all((r.evidence ?? []).map((e: any) => verifyEvidence(caseId, e)));
      const cited = checks.length > 0 && checks.every((c) => c.status === 'verified');
      send({ type: 'doctor', phase: 'diagnose', summary: r.summary, root_cause: r.root_cause, action: r.action, skill: r.skill, checks, model: MODELS.deep });
      const retry = (feedback: string) => {
        if (revisions++ >= 1) {
          result = { type: 'doctor', phase: 'done', action: 'rejected', detail: feedback };
          return { done: true as const };
        }
        return { done: false as const, feedback };
      };
      if (!cited) return retry('Evidence rejected: every quote must be verbatim from the self-case artifacts with correct line numbers. Re-read and resubmit.');
      if (r.action === 'none') {
        result = { type: 'doctor', phase: 'done', action: 'none', detail: r.rationale };
        return { done: true };
      }
      if (!r.skill || !view.get(r.skill)) return retry(`Unknown skill ${r.skill}. Only role or runbook skills listed in the registry can change.`);
      if (r.action === 'rollback') {
        const from = view.get(r.skill)!.version;
        const to = await reg.rollback(r.skill, 'doctor', r.rationale);
        send({ type: 'doctor', phase: 'rollback', skill: r.skill, from, to, by: 'doctor', reason: r.rationale });
        result = { type: 'doctor', phase: 'done', action: 'rollback', skill: r.skill };
        return { done: true };
      }
      const verdict = reg.check(r.skill, String(r.new_content ?? ''), 'doctor');
      send({ type: 'doctor', phase: 'policy', skill: r.skill, ok: verdict.ok, violations: verdict.violations, added: verdict.added.slice(0, 20) });
      if (!verdict.ok) return retry(`Policy guard rejected the patch: ${verdict.violations.map((v) => `${v.rule}: ${v.detail}`).join('; ')}. Propose a smaller change that keeps every core rule.`);
      const canaries = [...new Set([...failing, ...h.runs.filter((x) => x.correct).map((x) => x.incident)])].slice(0, 3);
      send({ type: 'doctor', phase: 'validate', skill: r.skill, canaries });
      const v = await validate(r.skill, String(r.new_content), canaries, baseline);
      send({ type: 'doctor', phase: 'validated', skill: r.skill, ...v });
      if (!v.ok) {
        result = { type: 'doctor', phase: 'done', action: 'rejected', detail: 'candidate failed validation; nothing changed', validation: v };
        return { done: true };
      }
      const version = await reg.addVersion(r.skill, String(r.new_content), 'doctor', r.rationale);
      await reg.activate(r.skill, version, 'doctor', `validated on ${canaries.join(', ')}`);
      send({ type: 'doctor', phase: 'promote', skill: r.skill, version });
      result = { type: 'doctor', phase: 'done', action: 'patch', skill: r.skill, version };
      return { done: true };
    },
  });
  return result ?? { type: 'doctor', phase: 'done', action: 'none', detail: 'doctor finished without an action' };
}
