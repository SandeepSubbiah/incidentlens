import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { startFakeModel, revisionScript } from './fake-model.ts';

const fake = await startFakeModel(revisionScript);
after(() => fake.close());
process.env.MODEL_BASE_URL = fake.url;
process.env.MODEL_API_KEY = 'test-key';
process.env.INCIDENTLENS_RUNS_DIR = path.join(os.tmpdir(), 'incidentlens-test-runs');
process.env.INCIDENTLENS_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'incidentlens-data-'));
process.env.LLM_WIRE = 'responses';
const { investigate } = await import('../src/agent.ts');

test('responses wire: fabricated citation is rejected, revision is accepted and scored', async () => {
  const events = await investigate('inc-001-pool-exhaustion', () => {});
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['start', 'step', 'step', 'verification', 'verification', 'report'], JSON.stringify(events.at(-1)));

  const [first, second] = events.filter((e) => e.type === 'verification') as any[];
  assert.equal(first.accepted, false);
  assert.deepEqual(first.checks.map((c: any) => c.status), ['verified', 'not_found']);
  assert.equal(second.accepted, true);

  const report = events.at(-1) as any;
  assert.equal(report.revised, true);
  assert.equal(report.score.correct, true);
  assert.equal(report.score.fix_target_correct, true);
  assert.equal(report.patch.status, 'applies');
  assert.equal(report.stats.steps, 2);

  // The rejection fed back to the model names the bad quote, and tool output carries line numbers.
  const third = fake.requests[3].body.input;
  const rejection = third.find((i: any) => i.type === 'function_call_output' && i.output.startsWith('Verification rejected'));
  assert.match(rejection.output, /quote not found in logs\/payment-service\.log/);
  const readOut = fake.requests[2].body.input.find((i: any) => i.type === 'function_call_output' && i.output.includes('34|'));
  assert.ok(readOut, 'read_artifact output reached the model');
  assert.equal(fake.requests[0].body.tools.length, 5);
});
