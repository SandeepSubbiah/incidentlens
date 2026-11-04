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
process.env.LLM_WIRE = 'messages';
const { investigate } = await import('../src/agent.ts');

test('messages wire: same loop, tool results returned as tool_result blocks', async () => {
  const events = await investigate('inc-001-pool-exhaustion', () => {});
  const report = events.at(-1) as any;
  assert.equal(report.type, 'report', JSON.stringify(report));
  assert.equal(report.revised, true);
  assert.equal(report.score.correct, true);

  assert.equal(fake.requests[0].url, '/v1/messages');
  assert.ok(fake.requests[0].body.tools[0].input_schema);
  const last = fake.requests[3].body.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].type, 'tool_result');
  assert.match(last.content[0].content, /Verification rejected/);
});
