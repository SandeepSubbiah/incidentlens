import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startRoleFake } from './fixtures/warroom-script.ts';

const fake = await startRoleFake();
after(() => fake.close());
process.env.MODEL_BASE_URL = fake.url;
process.env.MODEL_API_KEY = 'test-key';
process.env.LLM_WIRE = 'responses';
process.env.MODEL_DEEP = 'deep-model';
process.env.MODEL_FAST = 'fast-model';
process.env.INCIDENTLENS_RUNS_DIR = path.join(os.tmpdir(), 'incidentlens-test-runs');
process.env.INCIDENTLENS_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'incidentlens-wr-'));
const { runWarRoom } = await import('../src/warroom/run.ts');

test('war room: delegation, help requests, pre-emption, skeptic gate, verified fix', async () => {
  // inc-001 ships a P0 live update after 4 turns; concurrency 1 makes the order deterministic.
  const events = await runWarRoom('inc-001-pool-exhaustion', () => {}, { concurrency: 1 });
  const last = events.at(-1)!;
  assert.equal(last.type, 'report', JSON.stringify(events.filter((e) => e.type === 'error' || e.type === 'agent_error')));
  assert.equal(fake.overflow(), 0, 'every role followed its script exactly');

  // Citation gate: the invented quote never reached the board.
  assert.equal(events.filter((e) => e.type === 'fact_rejected').length, 1);
  assert.deepEqual(events.filter((e) => e.type === 'fact').map((e) => e.fact.id), ['F1', 'F2', 'F3', 'F4']);

  // Help request routed to the code agent, answered back to signals.
  const msgs = events.filter((e) => e.type === 'message').map((e) => e.message);
  assert.ok(msgs.some((m) => m.from === 'signals' && m.to === 'code' && m.kind === 'help'));
  assert.ok(msgs.some((m) => m.from === 'code' && m.to === 'signals' && m.kind === 'answer'));

  // Live P0 update pre-empts the P1 signals task, which later resumes with what changed.
  const types = events.map((e) => `${e.type}:${e.task ?? ''}`);
  const preempt = events.find((e) => e.type === 'preempt')!;
  assert.deepEqual([preempt.role, preempt.task, preempt.priority, preempt.by_priority], ['signals', 'T2', 1, 0]);
  assert.ok(types.indexOf('live_update:') < types.indexOf('preempt:T2'));
  assert.ok(types.indexOf('preempt:T2') < types.indexOf('resume:T2'));
  const signalsResume = fake.requests.filter((r) => r.role === 'signals')[3];
  assert.match(JSON.stringify(signalsResume.body.input), /Resuming your task T2 after higher-priority work/);

  // The commander could not conclude before the skeptic reviewed H1.
  assert.ok(events.some((e) => e.type === 'step' && e.label === 'Conclusion blocked: skeptic review required'));
  const hyps = events.filter((e) => e.type === 'hypothesis').map((e) => e.hypothesis);
  assert.equal(hyps.at(-1).status, 'supported');
  assert.equal(hyps.find((h) => h.review)?.review.verdict, 'stands');

  // Patch gate: invented lines rejected once, real patch accepted.
  assert.deepEqual(events.filter((e) => e.type === 'fix_check').map((e) => [e.patch.status, e.accepted]), [['mismatch', false], ['applies', true]]);

  // Fast model for specialists, deep model for commander, skeptic and fixer.
  for (const r of fake.requests) assert.equal(r.model, ['signals', 'platform', 'code'].includes(r.role) ? 'fast-model' : 'deep-model', `${r.role} used ${r.model}`);

  assert.equal(last.score.correct, true);
  assert.equal(last.score.fix_target_correct, true);
  assert.deepEqual(last.checks.map((c: any) => c.status), ['verified', 'verified']);
  assert.equal(last.patch.status, 'applies');
  assert.ok(last.report.mitigation.includes('Roll back payment-service to v2.13.x'));
  assert.equal(last.board.tasks.find((t: any) => t.id === 'T3').status, 'cancelled', 'unneeded low-priority work is cancelled at the end');
});
