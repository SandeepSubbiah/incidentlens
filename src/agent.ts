import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listArtifacts, loadGroundTruth, loadMeta, type IncidentMeta } from './incidents.ts';
import { createSession, MODEL, WIRE } from './llm.ts';
import { scoreReport, type Score } from './score.ts';
import { runTool, SUBMIT, TOOLS } from './tools.ts';
import { verifyEvidence, verifyPatch, type EvidenceCheck, type PatchCheck } from './verify.ts';

export const RUNS_DIR = process.env.INCIDENTLENS_RUNS_DIR ?? path.resolve(import.meta.dirname, '..', 'runs');

const MAX_STEPS = 30;
const MAX_REVISIONS = 1;

export type AgentEvent =
  | { type: 'start'; incident: IncidentMeta; model: string; wire: string; artifacts: number; at: string }
  | { type: 'thought'; text: string }
  | { type: 'step'; n: number; tool: string; args: any; label: string; ms: number; error?: string }
  | { type: 'verification'; round: number; checks: EvidenceCheck[]; patch: PatchCheck; accepted: boolean }
  | { type: 'report'; report: any; checks: EvidenceCheck[]; patch: PatchCheck; score: Score; stats: Stats; revised: boolean }
  | { type: 'error'; message: string };

export interface Stats {
  steps: number;
  seconds: number;
  input_tokens: number;
  output_tokens: number;
}

const SYSTEM = `You are IncidentLens, a senior site-reliability engineer investigating a production incident in Java/Spring Boot services running on Kubernetes.

Method:
1. Start with list_artifacts, then read the evidence. Prefer reading whole files; use search_artifacts to find specific signals across files.
2. Build a timeline. Correlate logs, traces, Kubernetes state, configuration, source code and recent changes.
3. Form competing hypotheses. Incidents contain noisy or coincidental signals; explicitly test and rule them out rather than reporting the loudest error.
4. Identify the causal chain: trigger -> mechanism -> customer impact. Name the specific change, setting or code path responsible.
5. Propose the smallest safe fix as a unified diff against an artifact you have read, and a regression test that would have caught it.

Rules:
- Never claim anything you have not read in an artifact. Evidence quotes must be copied verbatim from read_artifact output, without the "N| " line prefix, with the correct line numbers.
- Do not guess file contents. Lines starting with "-" in your patch must exist verbatim in the target artifact.
- Finish by calling submit_report exactly once. Do not write the report as plain text.`;

function userPrompt(meta: IncidentMeta, artifactCount: number): string {
  return `Incident ${meta.id} (${meta.severity}) — ${meta.title}
Service: ${meta.service}
Started: ${meta.started_at}
Alert: ${meta.alert}

${artifactCount} evidence artifacts are available. Investigate and submit your report.`;
}

function missingFields(report: any): string[] {
  const required = (TOOLS.find((t) => t.name === SUBMIT)!.parameters as any).required as string[];
  const missing = required.filter((k) => report?.[k] === undefined || report?.[k] === null);
  if (Array.isArray(report?.evidence) && report.evidence.length < 2) missing.push('evidence (need at least 2 items)');
  return missing;
}

async function check(incidentId: string, report: any) {
  const checks = await Promise.all((report.evidence ?? []).map((e: any) => verifyEvidence(incidentId, e)));
  const patch = await verifyPatch(incidentId, report.fix ?? { artifact: '', patch: '' });
  return { checks, patch };
}

function rejectionMessage(report: any, checks: EvidenceCheck[], patch: PatchCheck): string {
  const problems: string[] = [];
  checks.forEach((c, i) => {
    const e = report.evidence[i];
    if (c.status === 'not_found') problems.push(`evidence[${i}]: quote not found in ${e.artifact}: "${String(e.quote).slice(0, 160)}"`);
    if (c.status === 'missing_artifact') problems.push(`evidence[${i}]: artifact does not exist: ${e.artifact}`);
    if (c.status === 'misplaced') problems.push(`evidence[${i}]: quote exists in ${e.artifact} but at line ${c.found_line}, not ${e.start_line}-${e.end_line}`);
  });
  if (patch.status === 'mismatch') problems.push(`fix.patch: these removed/context lines do not exist in ${report.fix.artifact}: ${patch.missing.slice(0, 5).map((l) => JSON.stringify(l)).join(', ')}`);
  if (patch.status === 'missing_artifact') problems.push(`fix.artifact does not exist: ${report.fix?.artifact}`);
  return `Verification rejected your report:\n- ${problems.join('\n- ')}\nRe-read the artifacts as needed, correct these items, and call submit_report again with the full corrected report.`;
}

function accepted(checks: EvidenceCheck[], patch: PatchCheck): boolean {
  return checks.every((c) => c.status === 'verified') && (patch.status === 'applies' || patch.status === 'no_removals');
}

export async function investigate(incidentId: string, emit: (e: AgentEvent) => void): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const send = (e: AgentEvent) => {
    events.push(e);
    emit(e);
  };
  const started = Date.now();
  const usage = { input: 0, output: 0 };
  let steps = 0;
  try {
    const meta = await loadMeta(incidentId);
    const artifacts = await listArtifacts(incidentId);
    send({ type: 'start', incident: meta, model: MODEL, wire: WIRE, artifacts: artifacts.length, at: new Date().toISOString() });

    const session = createSession(SYSTEM, userPrompt(meta, artifacts.length), TOOLS);
    let revisions = 0;
    let nudged = false;

    for (let turnNo = 0; turnNo < MAX_STEPS + 5; turnNo++) {
      const turn = await session.next();
      usage.input += turn.usage.input;
      usage.output += turn.usage.output;
      if (turn.text.trim()) send({ type: 'thought', text: turn.text.trim() });

      if (!turn.calls.length) {
        if (nudged) throw new Error('model stopped without calling submit_report');
        nudged = true;
        session.addUserMessage('Continue the investigation using the tools, and finish by calling submit_report.');
        continue;
      }

      const results: { id: string; output: string }[] = [];
      for (const call of turn.calls) {
        if (call.parseError) {
          results.push({ id: call.id, output: `Error: arguments were not valid JSON (${call.parseError}). Retry.` });
          continue;
        }
        if (call.name === SUBMIT) {
          const report = call.args;
          const missing = missingFields(report);
          if (missing.length) {
            results.push({ id: call.id, output: `Error: report is missing required fields: ${missing.join(', ')}. Call submit_report again with all fields.` });
            continue;
          }
          const { checks, patch } = await check(incidentId, report);
          const ok = accepted(checks, patch);
          send({ type: 'verification', round: revisions + 1, checks, patch, accepted: ok });
          if (ok || revisions >= MAX_REVISIONS) {
            const score = scoreReport(report, await loadGroundTruth(incidentId));
            const stats = { steps, seconds: Math.round((Date.now() - started) / 100) / 10, input_tokens: usage.input, output_tokens: usage.output };
            send({ type: 'report', report, checks, patch, score, stats, revised: revisions > 0 });
            return events;
          }
          revisions++;
          results.push({ id: call.id, output: rejectionMessage(report, checks, patch) });
          continue;
        }

        steps++;
        const t0 = Date.now();
        try {
          const r = await runTool(incidentId, call.name, call.args);
          results.push({ id: call.id, output: r.output });
          send({ type: 'step', n: steps, tool: call.name, args: call.args, label: r.label, ms: Date.now() - t0 });
        } catch (err: any) {
          results.push({ id: call.id, output: `Error: ${err.message}` });
          send({ type: 'step', n: steps, tool: call.name, args: call.args, label: `${call.name} failed`, ms: Date.now() - t0, error: err.message });
        }
      }
      session.addToolResults(results);
      if (steps >= MAX_STEPS - 2) {
        session.addUserMessage(`Tool budget nearly exhausted (${steps}/${MAX_STEPS}). Call submit_report now with your best-supported conclusion.`);
      }
    }
    throw new Error(`no report after ${MAX_STEPS} tool calls`);
  } catch (err: any) {
    send({ type: 'error', message: err.message });
    return events;
  } finally {
    await saveRun(incidentId, events).catch(() => {});
  }
}

async function saveRun(incidentId: string, events: AgentEvent[]) {
  const dir = path.join(RUNS_DIR, incidentId);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(path.join(dir, `${stamp}.json`), JSON.stringify({ model: MODEL, wire: WIRE, events }, null, 2));
}
