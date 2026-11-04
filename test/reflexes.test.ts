import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// A model endpoint whose behaviour per model is scripted by the test.
type Behaviour = (body: any) => { status: number; body: any; headers?: Record<string, string> };
const behaviours: Record<string, Behaviour> = {};
const calls: { model: string; body: any }[] = [];
const ok = () => ({ status: 200, body: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }], usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 400 } } } });

const server = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  calls.push({ model: body.model, body });
  const r = (behaviours[body.model] ?? ok)(body);
  res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
  res.end(JSON.stringify(r.body));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

process.env.MODEL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.MODEL_API_KEY = 'test-key';
process.env.LLM_WIRE = 'responses';
process.env.MODEL_DEEP = 'deep-model';
process.env.MODEL_FAST = 'fast-model';
process.env.BREAKER_COOLDOWN_MS = '60000';
const { createSession, resetReflexes, reflexState, Usage, PRICING } = await import('../src/llm.ts');
const { setOutage, clearFaults } = await import('../src/chaos.ts');

beforeEach(() => {
  for (const k of Object.keys(behaviours)) delete behaviours[k];
  calls.length = 0;
  resetReflexes();
  clearFaults();
});

function session(heals: any[], usage?: InstanceType<typeof Usage>) {
  return createSession({ system: 's', user: 'u', tools: [], tier: 'deep', usage, onHeal: (h) => heals.push(h) });
}

test('deep model failing over 5xx fails over to the fast model, and repeated failures open the circuit', async () => {
  behaviours['deep-model'] = () => ({ status: 503, body: { error: 'overloaded' } });
  const heals: any[] = [];
  for (let i = 0; i < 3; i++) assert.equal((await session(heals).next()).model, 'fast-model');
  assert.ok(heals.some((h) => h.kind === 'circuit-open'));
  const before = calls.filter((c) => c.model === 'deep-model').length;
  assert.equal((await session(heals).next()).model, 'fast-model');
  assert.equal(calls.filter((c) => c.model === 'deep-model').length, before, 'an open circuit must not call the failing model');
  assert.equal(reflexState().breakers['deep-model'].open, true);
});

test('a 400 caused by optional reasoning settings is negotiated away and remembered', async () => {
  behaviours['deep-model'] = (body) => (body.reasoning ? { status: 400, body: { error: 'unknown parameter: reasoning' } } : ok());
  const heals: any[] = [];
  assert.equal((await session(heals).next()).model, 'deep-model');
  assert.ok(heals.some((h) => h.kind === 'param-negotiation'));
  const n = calls.length;
  await session([]).next();
  assert.equal(calls.length, n + 1, 'second session sends no reasoning and needs no retry');
  assert.equal(calls.at(-1)!.body.reasoning, undefined);
});

test('429 honours Retry-After', async () => {
  let first = true;
  behaviours['deep-model'] = () => {
    if (!first) return ok();
    first = false;
    return { status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '1' } };
  };
  const heals: any[] = [];
  const t0 = Date.now();
  await session(heals).next();
  assert.ok(Date.now() - t0 >= 950, 'waited for Retry-After');
  assert.ok(heals.some((h) => h.kind === 'rate-limited'));
});

test('chaos outage triggers failover without touching the network for the failed model', async () => {
  setOutage('deep-model', 30);
  const heals: any[] = [];
  const turn = await session(heals).next();
  assert.equal(turn.model, 'fast-model');
  assert.equal(calls.filter((c) => c.model === 'deep-model').length, 0);
  assert.ok(heals.some((h) => h.kind === 'failover'));
});

test('billing errors are not retried or failed over', async () => {
  behaviours['deep-model'] = () => ({ status: 402, body: { error: { code: 'billing_not_configured' } } });
  await assert.rejects(session([]).next(), /402/);
  assert.equal(calls.length, 1);
});

test('usage cost uses cached-input pricing', async () => {
  PRICING['deep-model'] = { input: 4, cached: 0.2, output: 20 };
  const usage = new Usage();
  await session([], usage).next();
  // (1000-400)*4 + 400*0.2 + 100*20 = 2400 + 80 + 2000 = 4480 per million
  assert.equal(usage.cost, 0.0045);
});
