import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Spend accounting: period buckets, running cost on each step, and spend from model calls that
// leave no run record (the self-repair Doctor). A local scripted model answers as Muse model names
// so prices apply, but the endpoint is not the Meta API, so every item must say "scripted".

process.env.INCIDENTLENS_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'incidentlens-costs-'));
process.env.INCIDENTLENS_RUNS_DIR = await mkdtemp(path.join(os.tmpdir(), 'incidentlens-costs-runs-'));
process.env.MODEL_API_KEY = 'synthetic-test-key';
process.env.MODEL_DEEP = 'muse-wonder-1.0';
process.env.MODEL_FAST = 'muse-spark-1.3';
process.env.CREDIT_BUDGET_USD = '150';
delete process.env.ACCESS_SECRET;

let script: { name: string; args: any }[] = [];
const fake = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const next = script.shift() ?? { name: 'list_artifacts', args: {} };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ model: JSON.parse(raw).model, output: [{ type: 'function_call', call_id: 'c', name: next.name, arguments: JSON.stringify(next.args) }], usage: { input_tokens: 10_000, output_tokens: 1_000 } }));
});
fake.listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
process.env.MODEL_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

const { spendSummary } = await import('../src/costs.ts');
const { createApp } = await import('../src/server.ts');
const { runDoctor } = await import('../src/heal/doctor.ts');
const { revisionScript } = await import('./fake-model.ts');

const server = createApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
after(() => {
  server.close();
  fake.close();
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// One Wonder call of 10k input + 1k output tokens costs $0.04 + $0.02 = $0.06.
const record = async (at: string, opts: { synthetic?: boolean } = {}) => {
  const dir = path.join(process.env.INCIDENTLENS_RUNS_DIR!, 'inc-test');
  await mkdir(dir, { recursive: true });
  const models = { 'muse-wonder-1.0': { input: 10_000, cached: 0, output: 1_000, calls: 1, served: 'muse-wonder-1.0' } };
  const events = [{ type: 'start', mode: 'solo', at, ...(opts.synthetic ? { synthetic: true } : { provenance: { incident: 'synthetic', inference: 'live' } }) }, { type: 'report', stats: { models } }];
  await writeFile(path.join(dir, `${at.replace(/[:.]/g, '-')}${opts.synthetic ? '-synthetic' : ''}.json`), JSON.stringify({ events }));
};

test('spend lands in the right calendar buckets; seeded synthetic runs are excluded', async () => {
  const now = new Date(2026, 10, 4, 15, 0); // Wed 4 Nov 2026, local time
  await record(new Date(2026, 10, 4, 9, 0).toISOString()); // today
  await record(new Date(2026, 10, 2, 9, 0).toISOString()); // Monday this week
  await record(new Date(2026, 9, 30, 9, 0).toISOString()); // last week, last month, same quarter
  await record(new Date(2026, 5, 15, 9, 0).toISOString()); // June: first half, Q2
  await record(new Date(2025, 11, 31, 9, 0).toISOString()); // last year
  await record(new Date(2026, 10, 4, 10, 0).toISOString(), { synthetic: true });
  const s = await spendSummary(now);
  const usd = (k: keyof typeof s.periods) => s.periods[k].usd;
  assert.equal(s.periods.today.operations, 1);
  assert.equal(usd('today'), 0.06);
  assert.equal(usd('week'), 0.12);
  assert.equal(usd('month'), 0.12);
  assert.equal(usd('quarter'), 0.18);
  assert.equal(usd('half'), 0.18);
  assert.equal(usd('year'), 0.24);
  assert.equal(usd('all'), 0.3);
  assert.equal(s.excluded.synthetic_runs, 1);
  assert.deepEqual(s.by_month.map((m) => m.period), ['2026-11', '2026-10', '2026-06', '2025-12']);
  assert.deepEqual(s.by_quarter.map((q) => q.period), ['2026-Q4', '2026-Q2', '2025-Q4']);
  assert.equal(s.remaining_usd, 149.7);
  assert.deepEqual(s.by_model[0].served, ['muse-wonder-1.0']);
});

test('each step of a run carries the run spend so far, and the run is counted as scripted', async () => {
  script = revisionScript.map((c) => ({ ...c }));
  const text = await (await fetch(`${base}/api/investigate/inc-001-pool-exhaustion`)).text();
  const steps = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((e) => e.type === 'step');
  assert.ok(steps.length >= 2);
  const costs = steps.map((s) => s.cost_usd);
  assert.ok(costs.every((c) => typeof c === 'number'), JSON.stringify(costs));
  assert.ok(costs.at(-1) > costs[0], `spend grows over the run: ${costs}`);
  assert.ok(steps.every((s) => s.model === 'muse-wonder-1.0'), 'each step names its model');
  const s = await (await fetch(`${base}/api/costs`)).json();
  assert.ok(s.by_inference.scripted.operations >= 1, 'a local endpoint is never counted as live');
});

test('self-repair spend is recorded even when the Doctor fails to finish', async () => {
  const before = (await spendSummary()).by_kind['self-repair']?.operations ?? 0;
  script = []; // the model only lists artifacts, so the Doctor runs out of steps
  const events = await runDoctor(() => {}, { force: true });
  assert.ok(events.some((e) => e.type === 'doctor' && e.phase === 'error'), 'control: the Doctor did fail');
  const after = (await spendSummary()).by_kind['self-repair'];
  assert.equal(after.operations, before + 1);
  assert.ok(after.usd > 0 && after.calls > 0);
  const ledger = await readdir(process.env.INCIDENTLENS_DATA_DIR!);
  assert.ok(ledger.includes('spend.jsonl'));
});
