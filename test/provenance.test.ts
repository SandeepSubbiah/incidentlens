import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Every record says where its data came from: synthetic incident or not, live Muse or a scripted
// model, and any simulated fault. Scripted model on 127.0.0.1, so inference must read "scripted".

process.env.INCIDENTLENS_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'incidentlens-provenance-'));
process.env.INCIDENTLENS_RUNS_DIR = await mkdtemp(path.join(os.tmpdir(), 'incidentlens-provenance-runs-'));
process.env.MODEL_API_KEY = 'synthetic-test-key';
process.env.MODEL_DEEP = 'deep-model';
process.env.MODEL_FAST = 'fast-model';
delete process.env.ACCESS_SECRET;

let script: { name: string; args: any }[] = [];
const fake = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const next = script.shift() ?? { name: 'list_artifacts', args: {} };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ model: JSON.parse(raw).model, output: [{ type: 'function_call', call_id: 'c', name: next.name, arguments: JSON.stringify(next.args) }], usage: { input_tokens: 1, output_tokens: 1 } }));
});
fake.listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
process.env.MODEL_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

const { createApp } = await import('../src/server.ts');
const { classifyEndpoint, resetReflexes } = await import('../src/llm.ts');
const { changeHash, listChanges } = await import('../src/governance/changes.ts');
const { ledger } = await import('../src/evolution/ledger.ts');
const { runDoctor } = await import('../src/heal/doctor.ts');
const { revisionScript } = await import('./fake-model.ts');

const server = createApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
after(() => {
  server.close();
  fake.close();
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const INC = 'inc-001-pool-exhaustion';
const getJson = async (p: string) => (await fetch(base + p)).json() as Promise<any>;
const chaos = (body: unknown) => fetch(`${base}/api/chaos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function investigate() {
  script = revisionScript.map((c) => ({ ...c }));
  const text = await (await fetch(`${base}/api/investigate/${INC}`)).text();
  return text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((e) => e.type);
}

test('only the Meta Model API counts as live inference', () => {
  assert.equal(classifyEndpoint('https://api.meta.ai').live, true, 'control');
  for (const url of ['http://127.0.0.1:8080', 'https://api.meta.ai.example.com', 'http://api.meta.ai', 'https://example.com/api.meta.ai']) {
    assert.equal(classifyEndpoint(url).live, false, url);
  }
});

test('every authored incident is served as synthetic, and the scripted endpoint is not called live', async () => {
  const incidents = await getJson('/api/incidents');
  assert.equal(incidents.length, 5);
  assert.deepEqual([...new Set(incidents.map((i: any) => i.provenance))], ['synthetic']);
  const cfg = await getJson('/api/config');
  assert.equal(cfg.endpoint.live, false);
  assert.match(cfg.endpoint.host, /^127\.0\.0\.1:\d+$/);
});

test('a run, its change request and its ledger entry carry the same provenance; the hash ignores it', async () => {
  const clean = (await investigate()).find((e) => e.type === 'start');
  assert.deepEqual(clean.provenance, { incident: 'synthetic', inference: 'scripted', endpoint: new URL(process.env.MODEL_BASE_URL!).host }, 'control run has no simulated fault');

  assert.equal((await chaos({ fault: 'outage', model: 'deep', seconds: 60 })).status, 200);
  const events = await investigate();
  await chaos({ fault: 'clear' });
  resetReflexes();
  const start = events.find((e) => e.type === 'start');
  assert.deepEqual(start.provenance.simulated_faults, ['model-outage deep-model']);

  const report = events.find((e) => e.type === 'report');
  const cr = (await listChanges()).find((c) => c.id === report.change_request.id)!;
  assert.deepEqual(cr.provenance, start.provenance);
  assert.equal(cr.hash, changeHash(cr.kind, cr.target, cr.payload), 'approval hash covers the change, not its label');

  const entry = (await ledger().entries()).find((e) => e.detail.signal === 'model-failover')!;
  assert.deepEqual(entry.detail.provenance, start.provenance);
  assert.equal(entry.detail.simulated, true);

  const dir = path.join(process.env.INCIDENTLENS_RUNS_DIR!, INC);
  const saved = await Promise.all((await readdir(dir)).map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
  assert.ok(saved.every((r) => r.events[0].provenance?.incident === 'synthetic'), 'every saved record is stamped');
});

test('seeded runs and the self-repair proposal they cause are labelled synthetic', async () => {
  assert.equal((await chaos({ fault: 'seed-regression' })).status, 200);
  // Both models down, so the Doctor cannot be consulted and the no-model reflex acts.
  await chaos({ fault: 'outage', model: 'deep', seconds: 60 });
  await chaos({ fault: 'outage', model: 'fast', seconds: 60 });
  await runDoctor(() => {});
  await chaos({ fault: 'clear' });
  resetReflexes();

  const seeded = await Promise.all((await readdir(path.join(process.env.INCIDENTLENS_RUNS_DIR!, INC))).filter((f) => f.endsWith('-synthetic.json')).map(async (f) => JSON.parse(await readFile(path.join(process.env.INCIDENTLENS_RUNS_DIR!, INC, f), 'utf8'))));
  assert.ok(seeded.length > 0);
  assert.deepEqual(seeded[0].events[0].provenance, { incident: 'synthetic', inference: 'none' });

  const rollback = (await listChanges()).find((c) => c.kind === 'skill-rollback')!;
  assert.ok(rollback, 'the reflex filed a rollback');
  assert.equal(rollback.provenance?.incident, 'self-case');
  assert.equal(rollback.provenance?.inference, 'none');
  assert.ok((rollback.provenance?.synthetic_runs ?? 0) >= 5, `synthetic runs counted: ${rollback.provenance?.synthetic_runs}`);
  assert.ok(rollback.provenance?.simulated_faults?.length, 'the outage that forced the reflex is named');
});
