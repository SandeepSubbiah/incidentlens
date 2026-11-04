import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { investigate } from './agent.ts';
import { runWarRoom } from './warroom/run.ts';
import { listIncidents } from './incidents.ts';
import { MODEL, WIRE } from './llm.ts';

// Runs the agent over every incident (or those named on the command line) and scores it
// against the hidden ground truth. Usage: node src/eval.ts [incident-id ...]

const EVAL_DIR = path.resolve(import.meta.dirname, '..', 'eval');
const argv = process.argv.slice(2);
const mode = argv.includes('--warroom') ? 'warroom' : 'solo';
const only = argv.filter((a) => !a.startsWith('--'));
const incidents = (await listIncidents()).filter((i) => !only.length || only.includes(i.id));

const rows: any[] = [];
for (const inc of incidents) {
  process.stdout.write(`${inc.id} ... `);
  const events = mode === 'warroom' ? await runWarRoom(inc.id, () => {}) : await investigate(inc.id, () => {});
  const report: any = events.find((e) => e.type === 'report');
  const error: any = events.find((e) => e.type === 'error');
  if (!report) {
    rows.push({ id: inc.id, error: error?.message ?? 'no report' });
    console.log(`ERROR ${error?.message ?? ''}`);
    continue;
  }
  const verified = report.checks.filter((c: any) => c.status === 'verified').length;
  const row = {
    id: inc.id,
    correct: report.score.correct,
    fix_target_correct: report.score.fix_target_correct,
    evidence_verified: verified,
    evidence_total: report.checks.length,
    patch: report.patch.status,
    revised: report.revised,
    confidence: report.report.confidence,
    steps: report.stats.steps,
    seconds: report.stats.seconds,
    tokens: report.stats.input_tokens + report.stats.output_tokens,
    missed_terms: report.score.groups.filter((g: any) => !g.hit).map((g: any) => g.any.join('|')),
  };
  rows.push(row);
  console.log(`${row.correct ? 'CORRECT' : 'WRONG  '} evidence ${verified}/${row.evidence_total} verified, patch ${row.patch}, ${row.steps} steps, ${row.seconds}s`);
}

const scored = rows.filter((r) => !r.error);
const summary = {
  model: MODEL,
  mode,
  wire: WIRE,
  at: new Date().toISOString(),
  incidents: rows.length,
  errors: rows.length - scored.length,
  correct: scored.filter((r) => r.correct).length,
  fix_target_correct: scored.filter((r) => r.fix_target_correct).length,
  evidence_verified: scored.reduce((n, r) => n + r.evidence_verified, 0),
  evidence_total: scored.reduce((n, r) => n + r.evidence_total, 0),
  patches_apply: scored.filter((r) => r.patch === 'applies').length,
  rows,
};
console.log(`\nRoot cause correct: ${summary.correct}/${summary.incidents}  |  fix target correct: ${summary.fix_target_correct}/${summary.incidents}  |  evidence verified: ${summary.evidence_verified}/${summary.evidence_total}  |  patches apply: ${summary.patches_apply}/${summary.incidents}  |  errors: ${summary.errors}`);

await mkdir(EVAL_DIR, { recursive: true });
const stamp = summary.at.replace(/[:.]/g, '-');
await writeFile(path.join(EVAL_DIR, `results-${stamp}.json`), JSON.stringify(summary, null, 2));
// Partial runs (named incidents) must not overwrite the full-suite headline.
if (!only.length) await writeFile(path.join(EVAL_DIR, mode === 'warroom' ? 'latest-warroom.json' : 'latest.json'), JSON.stringify(summary, null, 2));
