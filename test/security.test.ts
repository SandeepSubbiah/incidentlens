import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Regression tests for the findings fixed in docs/SECURITY_ASSURANCE_FINDINGS.md. Each pairs the
// refused case with a control that must still work, so a test cannot pass by blocking everything.

process.env.INCIDENTLENS_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'incidentlens-security-'));
process.env.INCIDENTLENS_RUNS_DIR = await mkdtemp(path.join(os.tmpdir(), 'incidentlens-security-runs-'));
process.env.MODEL_API_KEY = 'synthetic-test-key';
delete process.env.ACCESS_SECRET;

// Scripted model that names itself, so provenance can be checked against what it reports. It
// lists artifacts forever unless given a script that ends in a report.
let calls = 0;
let script: { name: string; args: any }[] = [];
const fake = createServer(async (req, res) => {
  for await (const _ of req);
  calls++;
  const next = script.shift() ?? { name: 'list_artifacts', args: {} };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ model: 'scripted-served-name', output: [{ type: 'function_call', call_id: `c${calls}`, name: next.name, arguments: JSON.stringify(next.args) }], usage: { input_tokens: 1, output_tokens: 1 } }));
});
fake.listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
process.env.MODEL_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

const { createApp } = await import('../src/server.ts');
const { mintToken, verifyToken } = await import('../src/access.ts');
const { Board } = await import('../src/warroom/board.ts');
const { revisionScript } = await import('./fake-model.ts');

const server = createApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
after(() => {
  server.close();
  fake.close();
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const INC = 'inc-001-pool-exhaustion';
const get = async (p: string, headers: Record<string, string> = {}) => {
  const r = await fetch(base + p, { headers });
  return { status: r.status, text: await r.text() };
};

test('a cross-site or same-site browser request cannot start an investigation or self-repair', async () => {
  const before = calls;
  assert.equal((await get(`/api/investigate/${INC}`, { 'sec-fetch-site': 'same-origin' })).status, 200, 'the UI itself still works');
  assert.ok(calls > before, 'control run reached the model');
  const mid = calls;
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await get(`/api/investigate/${INC}`, { 'sec-fetch-site': site })).status, 403, site);
    assert.equal((await get('/api/heal/run', { 'sec-fetch-site': site })).status, 403, `${site} self-repair`);
  }
  assert.equal(calls, mid, 'no model call from refused requests');
  assert.equal((await get('/api/config', { 'sec-fetch-site': 'cross-site' })).status, 200, 'plain reads are unaffected');
});

test('the run record keeps the model name the API reported, not only the configured one', async () => {
  script = revisionScript.map((c) => ({ ...c }));
  assert.equal((await get(`/api/investigate/${INC}`)).status, 200);
  const dir = path.join(process.env.INCIDENTLENS_RUNS_DIR!, INC);
  const file = (await readdir(dir)).sort().at(-1)!;
  const run = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
  const report = run.events.find((e: any) => e.type === 'report');
  assert.ok(report, 'control: the scripted run produced a report');
  const served = Object.values(report.stats.models).map((m: any) => m.served);
  assert.deepEqual(served, ['scripted-served-name']);
});

test('a run that fails still records its spend and the model that answered', async () => {
  const dir = path.join(process.env.INCIDENTLENS_RUNS_DIR!, INC);
  const runs = await Promise.all((await readdir(dir)).map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
  const failed = runs.map((r) => r.events.find((e: any) => e.type === 'error')).find(Boolean);
  assert.ok(failed, 'control: the endless scripted run ended in an error');
  assert.ok(failed.usage.cost_usd >= 0);
  assert.deepEqual(Object.values(failed.usage.models).map((m: any) => m.served), ['scripted-served-name']);
});

test('a signed code must carry a subject and a numeric run budget', () => {
  process.env.ACCESS_SECRET = 'security-test-secret-0123456789abcdef';
  try {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    assert.ok(verifyToken(mintToken({ sub: 'ok', role: 'judge', exp, runs: 2 })), 'control: a well-formed code verifies');
    for (const claims of [{ sub: 'x', role: 'judge', exp }, { sub: 'x', role: 'judge', exp, runs: 'many' }, { role: 'judge', exp, runs: 1 }, { sub: 'x', role: 'judge', exp, runs: -1 }]) {
      assert.equal(verifyToken(mintToken(claims as any)), null, JSON.stringify(claims));
    }
  } finally {
    delete process.env.ACCESS_SECRET;
  }
});

test('two simultaneous requests cannot both spend the last run of a code', async () => {
  process.env.ACCESS_SECRET = 'security-test-secret-0123456789abcdef';
  try {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const fire = (t: string) => Promise.all([0, 1].map(() => get(`/api/investigate/${INC}`, { authorization: `Bearer ${t}` })));
    const two = await fire(mintToken({ sub: 'race-two', role: 'judge', exp, runs: 2 }));
    assert.deepEqual(two.map((r) => r.status).sort(), [200, 200], 'control: a code with 2 runs starts both');
    const one = await fire(mintToken({ sub: 'race-one', role: 'judge', exp, runs: 1 }));
    assert.deepEqual(one.map((r) => r.status).sort(), [200, 429], 'a code with 1 run starts exactly one');
  } finally {
    delete process.env.ACCESS_SECRET;
  }
});

test('a missing incident is a plain 404 that reveals no server path', async () => {
  const r = await get('/api/incidents/no-such-incident/artifacts');
  assert.equal(r.status, 404);
  assert.ok(!r.text.includes(os.homedir()) && !r.text.includes(JSON.stringify(os.homedir()).slice(1, -1)), r.text);
});

test('a rejected fact keeps the whole quote, so the rejection can be audited', async () => {
  const events: any[] = [];
  const board = new Board(INC, (e: any) => events.push(e));
  const quote = `${'invented log line '.repeat(30)}END`;
  const result = await board.postFact('signals', { claim: 'probe', artifact: 'logs/payment-service.log', start_line: 1, end_line: 2, quote });
  assert.equal(result.ok, false);
  assert.equal(events.find((e) => e.type === 'fact_rejected')?.quote, quote);
});
