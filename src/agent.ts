import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConstitution } from './guard/constitution.ts';
import { listArtifacts, loadGroundTruth, loadMeta, type IncidentMeta } from './incidents.ts';
import { MODELS, Usage, WIRE } from './llm.ts';
import { runToolLoop, type AgentEvent, type Emit } from './loop.ts';
import { gateRemediation } from './remediation.ts';
import { scoreReport } from './score.ts';
import { buildKnowledge, loadCases, saveCase } from './skills/knowledge.ts';
import { getRegistry, type RegistryView, type Skill } from './skills/registry.ts';
import { SUBMIT, SUBMIT_TOOL, TOOLS, type ToolContext } from './tools.ts';
import { verifyEvidence, verifyPatch, type EvidenceCheck, type PatchCheck } from './verify.ts';

export type { AgentEvent } from './loop.ts';

export const RUNS_DIR = process.env.INCIDENTLENS_RUNS_DIR ?? path.resolve(import.meta.dirname, '..', 'runs');

const MAX_REVISIONS = 1;

export function systemPrompt(constitution: string, role: Skill | undefined): string {
  if (!role) throw new Error('role skill missing from registry');
  return `${constitution}\n\n---\n\n${role.body.trim()}`;
}

export function incidentBrief(meta: IncidentMeta, artifactCount: number): string {
  return `Incident ${meta.id} (${meta.severity}) — ${meta.title}
Service: ${meta.service}
Started: ${meta.started_at}
Alert: ${meta.alert}

${artifactCount} evidence artifacts are available.`;
}

export function missingFields(report: any): string[] {
  const required = (SUBMIT_TOOL.parameters as any).required as string[];
  const missing = required.filter((k) => report?.[k] === undefined || report?.[k] === null);
  if (Array.isArray(report?.evidence) && report.evidence.length < 2) missing.push('evidence (need at least 2 items)');
  return missing;
}

export async function checkReport(caseId: string, report: any) {
  const checks: EvidenceCheck[] = await Promise.all((report.evidence ?? []).map((e: any) => verifyEvidence(caseId, e)));
  const patch: PatchCheck = await verifyPatch(caseId, report.fix ?? { artifact: '', patch: '' });
  return { checks, patch };
}

export function rejectionMessage(report: any, checks: EvidenceCheck[], patch: PatchCheck): string {
  const problems: string[] = [];
  checks.forEach((c, i) => {
    const e = report.evidence[i];
    if (c.status === 'not_found') problems.push(`evidence[${i}]: quote not found in ${e.artifact}: "${String(e.quote).slice(0, 160)}"`);
    if (c.status === 'missing_artifact') problems.push(`evidence[${i}]: artifact does not exist: ${e.artifact}`);
    if (c.status === 'misplaced') problems.push(`evidence[${i}]: quote exists in ${e.artifact} but at line ${c.found_line}, not ${e.start_line}-${e.end_line}`);
  });
  if (patch.status === 'mismatch') problems.push(`fix.patch: these removed/context lines do not exist in ${report.fix.artifact}: ${patch.missing.slice(0, 5).map((l) => JSON.stringify(l)).join(', ')}`);
  if (patch.status === 'missing_artifact') problems.push(`fix.artifact does not exist: ${report.fix?.artifact}`);
  return `Verification rejected your report:\n- ${problems.join('\n- ')}\nRe-read the artifacts as needed, correct these items, and submit again with the full corrected report.`;
}

export function accepted(checks: EvidenceCheck[], patch: PatchCheck): boolean {
  return checks.every((c) => c.status === 'verified') && (patch.status === 'applies' || patch.status === 'no_removals');
}

export function stats(steps: number, started: number, usage: Usage) {
  return {
    steps,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    input_tokens: usage.input,
    output_tokens: usage.output,
    cost_usd: usage.cost,
    models: usage.byModel,
  };
}

// Reports that passed verification and matched the answer key become retrievable past cases.
// In production the equivalent trigger is a human-approved postmortem.
export async function learnCase(meta: IncidentMeta, report: any) {
  await saveCase({
    incident_id: meta.id,
    title: meta.title,
    service: meta.service,
    summary: String(report.summary ?? ''),
    root_cause: String(report.root_cause ?? ''),
    category: String(report.category ?? 'other'),
    at: new Date().toISOString(),
  }).catch(() => {});
}

export function quarantineTracker(send: Emit) {
  const seen = new Set<string>();
  return (q: { artifact: string; line: number; text: string }) => {
    const key = `${q.artifact}:${q.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    send({ type: 'quarantine', ...q });
  };
}

export async function investigate(incidentId: string, emit: Emit, opts: { view?: RegistryView; record?: boolean } = {}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const send: Emit = (e) => {
    events.push(e);
    emit(e);
  };
  const started = Date.now();
  const usage = new Usage();
  try {
    const constitution = loadConstitution();
    const view = opts.view ?? (await getRegistry()).view();
    const meta = await loadMeta(incidentId);
    const artifacts = await listArtifacts(incidentId);
    send({ type: 'start', mode: 'solo', incident: meta, model: MODELS.deep, wire: WIRE, artifacts: artifacts.length, at: new Date().toISOString(), skills: { revision: view.revision, versions: view.versions(), candidate: view.overridden } });

    const ctx: ToolContext = { caseId: incidentId, knowledge: buildKnowledge(view, await loadCases()), onQuarantine: quarantineTracker(send) };
    let revisions = 0;
    await runToolLoop({
      system: systemPrompt(constitution, view.get('solo')),
      user: `${incidentBrief(meta, artifacts.length)} Investigate and submit your report.`,
      tools: TOOLS,
      submitName: SUBMIT,
      tier: 'deep',
      ctx,
      usage,
      send,
      onSubmit: async (report, state) => {
        const missing = missingFields(report);
        if (missing.length) return { done: false, feedback: `Error: report is missing required fields: ${missing.join(', ')}. Call ${SUBMIT} again with all fields.` };
        const { checks, patch } = await checkReport(incidentId, report);
        const ok = accepted(checks, patch);
        send({ type: 'verification', round: revisions + 1, checks, patch, accepted: ok });
        if (ok || revisions >= MAX_REVISIONS) {
          const score = scoreReport(report, await loadGroundTruth(incidentId));
          const gate = await gateRemediation(incidentId, meta, report, 'solo', opts.record !== false && !view.overridden.length);
          send({ type: 'report', report, checks, patch, score, stats: stats(state.steps, started, usage), revised: revisions > 0, ...gate });
          if (ok && score.correct && !view.overridden.length) await learnCase(meta, report);
          return { done: true };
        }
        revisions++;
        return { done: false, feedback: rejectionMessage(report, checks, patch) };
      },
    });
  } catch (err: any) {
    // Spend and the models that actually answered are recorded even when the run fails.
    send({ type: 'error', message: err.message, usage: { cost_usd: usage.cost, models: usage.byModel } });
  } finally {
    if (opts.record !== false) await saveRun(incidentId, events).catch(() => {});
  }
  return events;
}

export async function saveRun(incidentId: string, events: AgentEvent[]) {
  const dir = path.join(RUNS_DIR, incidentId);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(path.join(dir, `${stamp}.json`), JSON.stringify({ model: MODELS.deep, wire: WIRE, events }, null, 2));
}
