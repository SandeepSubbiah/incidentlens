import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'test-secret-0123456789-abcdefghijklmnop';
process.env.ACCESS_SECRET = SECRET;
process.env.INCIDENTLENS_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'incidentlens-access-'));
process.env.INCIDENTLENS_RUNS_DIR = path.join(os.tmpdir(), 'incidentlens-test-runs');
delete process.env.MODEL_API_KEY;
const { mintToken, verifyToken } = await import('../src/access.ts');
const { createApp } = await import('../src/server.ts');

const server = createApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const day = () => Math.floor(Date.now() / 1000) + 86400;
const judge = (runs = 5) => mintToken({ sub: `judge-${runs}`, role: 'judge', exp: day(), runs });
const admin = () => mintToken({ sub: 'admin', role: 'admin', exp: day(), runs: 100 });
const get = (p: string, token?: string) => fetch(base + p, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test('codes verify; tampered, re-signed, expired and malformed codes do not', () => {
  const t = judge();
  assert.equal(verifyToken(t)?.role, 'judge');
  const [payload, sig] = t.split('.');
  const elevated = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), role: 'admin' })).toString('base64url');
  assert.equal(verifyToken(`${elevated}.${sig}`), null, 'payload edited after signing');
  assert.equal(verifyToken(mintToken({ sub: 'x', role: 'admin', exp: day(), runs: 1 }, 'another-secret-0123456789-abcdefghijk')), null, 'signed with a different secret');
  assert.equal(verifyToken(mintToken({ sub: 'x', role: 'judge', exp: Math.floor(Date.now() / 1000) - 1, runs: 1 })), null, 'expired');
  assert.equal(verifyToken('garbage'), null);
  assert.equal(verifyToken(`${t}.extra`), null);
  assert.throws(() => mintToken({ sub: 'x', role: 'judge', exp: day(), runs: 1 }, 'short'), /at least 32/);
});

test('read-only views are public and carry security headers; live work needs a code', async () => {
  const cfg = await get('/api/config');
  assert.equal(cfg.status, 200);
  assert.equal((await cfg.json()).gated, true);
  assert.match(cfg.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.equal(cfg.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await get('/api/incidents')).status, 200);
  assert.equal((await get('/api/skills')).status, 200);
  assert.equal((await get('/api/investigate/inc-001-pool-exhaustion')).status, 401);
  assert.equal((await get('/api/heal/run')).status, 401);
});

test('roles and budgets are enforced before anything is spent', async () => {
  assert.equal((await get('/api/investigate/inc-001-pool-exhaustion', judge(0))).status, 429);
  const t = judge(3);
  const unknown = await get('/api/investigate/no-such-incident', t);
  assert.equal(unknown.status, 404);
  assert.equal((await (await get('/api/session', t)).json()).runs_left, 3, 'a rejected request is not charged');
  const chaos = (token: string) => fetch(base + '/api/chaos', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ fault: 'clear' }) });
  assert.equal((await chaos(t)).status, 403);
  assert.equal((await chaos(admin())).status, 200);
});

test('login sets an HttpOnly cookie; repeated bad codes are rate limited', async () => {
  const t = judge();
  const ok = await fetch(base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: t }) });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie') ?? '', /il_session=.+; HttpOnly; SameSite=Strict/);
  const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0];
  assert.equal((await (await fetch(base + '/api/session', { headers: { cookie } })).json()).role, 'judge');

  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await fetch(base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: `bad-${i}` }) })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.equal(statuses[10], 429);
});
