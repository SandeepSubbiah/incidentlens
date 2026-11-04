import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { RUNS_DIR } from '../agent.ts';

// Service-level indicators for IncidentLens itself, computed from its own run records.

export interface RunSummary {
  file: string;
  incident: string;
  mode: string;
  at: string;
  ok: boolean;
  correct: boolean | null;
  citations: number;
  rejected_citations: number;
  tool_calls: number;
  tool_errors: number;
  heals: number;
  quarantined: number;
  cost_usd: number;
  versions: Record<string, number>;
  synthetic: boolean;
  error?: string;
  missed?: string[];
}

export interface Slo {
  name: string;
  value: number | null;
  objective: string;
  breached: boolean;
}

export interface Health {
  window: number;
  runs: RunSummary[];
  slis: Slo[];
  breaches: Slo[];
  healthy: boolean;
  sufficient: boolean;
  min_runs: number;
  synthetic_runs: number;
}

const WINDOW = 8;
// Below this many runs, indicators are shown but never treated as a breach.
export const MIN_RUNS = 5;

export function summarizeRun(file: string, run: any): RunSummary {
  const events: any[] = run.events ?? [];
  const start = events.find((e) => e.type === 'start') ?? {};
  const report = events.find((e) => e.type === 'report');
  const error = events.find((e) => e.type === 'error');
  // Solo: citations checked in verification rounds. War Room: facts posted vs rejected.
  const rounds = events.filter((e) => e.type === 'verification');
  const facts = events.filter((e) => e.type === 'fact').length;
  const rejectedFacts = events.filter((e) => e.type === 'fact_rejected').length;
  const citations = rounds.reduce((n, r) => n + r.checks.length, 0) + facts + rejectedFacts;
  const rejected = rounds.reduce((n, r) => n + r.checks.filter((c: any) => c.status !== 'verified').length, 0) + rejectedFacts;
  const steps = events.filter((e) => e.type === 'step');
  return {
    file,
    incident: start.incident?.id ?? path.basename(path.dirname(file)),
    mode: start.mode ?? 'solo',
    at: start.at ?? '',
    ok: !!report,
    correct: report ? !!report.score?.correct : null,
    citations,
    rejected_citations: rejected,
    tool_calls: steps.length,
    tool_errors: steps.filter((s) => s.error).length,
    heals: events.filter((e) => e.type === 'heal').length,
    quarantined: events.filter((e) => e.type === 'quarantine').length,
    cost_usd: report?.stats?.cost_usd ?? 0,
    versions: start.skills?.versions ?? {},
    synthetic: !!(run.synthetic || start.synthetic),
    error: error?.message,
    missed: report ? report.score.groups.filter((g: any) => !g.hit).map((g: any) => g.any.join('|')) : undefined,
  };
}

export async function recentRuns(limit = WINDOW): Promise<RunSummary[]> {
  const all: RunSummary[] = [];
  for (const dir of await readdir(RUNS_DIR).catch(() => [] as string[])) {
    if (dir.startsWith('self-')) continue;
    for (const f of await readdir(path.join(RUNS_DIR, dir)).catch(() => [] as string[])) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(RUNS_DIR, dir, f);
      try {
        all.push(summarizeRun(file, JSON.parse(await readFile(file, 'utf8'))));
      } catch {
        // A corrupt run record is itself a signal, but not one this summary can use.
      }
    }
  }
  return all.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

const ratio = (n: number, d: number) => (d ? Math.round((n / d) * 100) / 100 : null);

export function assess(runs: RunSummary[]): Health {
  const reports = runs.filter((r) => r.ok);
  const citations = runs.reduce((n, r) => n + r.citations, 0);
  const calls = runs.reduce((n, r) => n + r.tool_calls, 0);
  const slo = (name: string, value: number | null, objective: string, breached: (v: number) => boolean): Slo => ({ name, value, objective, breached: value !== null && breached(value) });
  const slis = [
    slo('diagnosis_accuracy', ratio(reports.filter((r) => r.correct).length, reports.length), '>= 0.75', (v) => v < 0.75),
    slo('run_failure_rate', ratio(runs.filter((r) => !r.ok).length, runs.length), '<= 0.20', (v) => v > 0.2),
    slo('citation_rejection_rate', ratio(runs.reduce((n, r) => n + r.rejected_citations, 0), citations), '<= 0.30', (v) => v > 0.3),
    slo('tool_error_rate', ratio(runs.reduce((n, r) => n + r.tool_errors, 0), calls), '<= 0.25', (v) => v > 0.25),
  ];
  const breaches = runs.length >= MIN_RUNS ? slis.filter((s) => s.breached) : [];
  return { window: runs.length, runs, slis, breaches, healthy: breaches.length === 0, sufficient: runs.length >= MIN_RUNS, min_runs: MIN_RUNS, synthetic_runs: runs.filter((r) => r.synthetic).length };
}

export async function health(): Promise<Health> {
  return assess(await recentRuns());
}
