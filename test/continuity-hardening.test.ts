import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuityRouter, ProviderFailure, type Endpoint, type RequestScope } from '../src/continuity/router.ts';
const scope = (x: Partial<RequestScope> = {}): RequestScope => ({requestId:'r1',tenantId:'t1',dataClass:'internal',operation:'diagnose',neededCapabilities:['tools'],allowedEndpointIds:['a','b'],allowedRegions:['ca'],primaryEndpointId:'a',allowFallback:true,safeToRetry:true,outputCommitted:false,...x});
const endpoint = (id: string, invoke: Endpoint<string>['invoke'], x: Partial<Endpoint<string>> = {}): Endpoint<string> => ({id, region:'ca', enabled:true, priority:id==='a'?0:1, allowedTenants:['t1'], dataClasses:['internal'], operations:['diagnose'], capabilities:['tools'], invoke,...x});
const fail = (kind: ConstructorParameters<typeof ProviderFailure>[0]) => async () => { throw new ProviderFailure(kind, kind); };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
test('telemetry failure on success does not change provider result', async () => {
  const r = new ContinuityRouter([endpoint('a', async () => 'ok')], () => { throw new Error('sink down'); });
  assert.deepEqual(await r.execute(scope()), { value:'ok', endpointId:'a', attempts:1, fallback:false });
  assert.equal(r.telemetryFailureCount, 2);
});
test('telemetry failure on provider failure does not block fallback', async () => {
  const r = new ContinuityRouter([endpoint('a', fail('unavailable')), endpoint('b', async () => 'recovered')], () => { throw new Error('sink down'); });
  assert.equal((await r.execute(scope())).value, 'recovered');
  assert.ok(r.telemetryFailureCount >= 3);
});
test('telemetry failure on skipped/breaker_open does not break routing', async () => {
  let now = 100; let a = 0;
  const r = new ContinuityRouter([endpoint('a', async () => { a++; throw new ProviderFailure('timeout','bad'); }), endpoint('b', async () => 'backup')], () => { throw new Error('sink down'); }, () => now, 1, 30);
  await r.execute(scope());
  const res = await r.execute(scope());
  assert.equal(res.endpointId, 'b'); assert.equal(a, 1);
});
test('already-committed request invokes no endpoint regardless of safeToRetry', async () => {
  for (const safeToRetry of [true, false]) {
    let calls = 0;
    const r = new ContinuityRouter([endpoint('a', async () => { calls++; return 'dup'; }), endpoint('b', async () => { calls++; return 'dup'; })]);
    await assert.rejects(r.execute(scope({ outputCommitted:true, safeToRetry })), /cannot retry committed output/);
    assert.equal(calls, 0, 'safeToRetry=' + safeToRetry);
  }
});
test('per-attempt timeout fails over and late completion is ignored', async () => {
  let late = false;
  const r = new ContinuityRouter([endpoint('a', async () => { await delay(120); late = true; return 'late'; }), endpoint('b', async () => 'backup')], () => {}, () => Date.now(), 2, 30000, { perAttemptTimeoutMs: 20, overallTimeoutMs: 500 });
  const started = Date.now();
  const res = await r.execute(scope());
  assert.equal(res.value, 'backup'); assert.ok(Date.now() - started < 100, 'elapsed');
  await delay(150); assert.equal(late, true);
});
test('endpoint ignoring AbortSignal and never settling still times out', async () => {
  const r = new ContinuityRouter([endpoint('a', () => new Promise<string>(() => {}))], () => {}, () => Date.now(), 2, 30000, { perAttemptTimeoutMs: 20, overallTimeoutMs: 100 });
  await assert.rejects(r.execute(scope({ allowFallback:false })), /timeout/);
});
test('overall deadline bounds total time across attempts', async () => {
  const hang = () => new Promise<string>(() => {});
  const r = new ContinuityRouter([endpoint('a', hang), endpoint('b', hang)], () => {}, () => Date.now(), 5, 30000, { perAttemptTimeoutMs: 10000, overallTimeoutMs: 40 });
  const started = Date.now();
  await assert.rejects(r.execute(scope()), /timeout/);
  assert.ok(Date.now() - started < 500, 'elapsed');
});
test('caller cancellation aborts promptly and does not fail over', async () => {
  const ctl = new AbortController(); let b = 0;
  const r = new ContinuityRouter([endpoint('a', () => new Promise<string>(() => {})), endpoint('b', async () => { b++; return 'bad'; })], () => {}, () => Date.now(), 2, 30000, { perAttemptTimeoutMs: 10000, overallTimeoutMs: 10000 });
  const promise = r.execute(scope(), ctl.signal); setTimeout(() => ctl.abort(), 20);
  await assert.rejects(promise, /abort|timeout/i); assert.equal(b, 0);
});
test('half-open permits exactly one concurrent probe; others fail over', async () => {
  let now = 100; let probes = 0; let release: (v: string) => void = () => {};
  const gate = new Promise<string>((res) => { release = res; });
  let mode = 'fail';
  const a = endpoint('a', async () => { if (mode === 'fail') throw new ProviderFailure('timeout','bad'); probes++; return gate; });
  const r = new ContinuityRouter([a, endpoint('b', async () => 'backup')], () => {}, () => now, 1, 30, { halfOpenSuccessThreshold: 1 });
  assert.equal((await r.execute(scope())).endpointId, 'b'); assert.equal(r.health().find((h) => h.endpointId === 'a')?.state, 'open');
  now = 200; mode = 'gate';
  const p1 = r.execute(scope()); const p2 = r.execute(scope()); const p3 = r.execute(scope());
  const others = await Promise.all([p2, p3]);
  assert.ok(others.every((o) => o.endpointId === 'b')); assert.equal(probes, 1);
  release('recovered'); assert.equal((await p1).value, 'recovered');
  assert.equal(r.health().find((h) => h.endpointId === 'a')?.state, 'closed');
});
test('half-open recovery requires configured success threshold', async () => {
  let now = 100; let mode = 'fail'; let calls = 0;
  const a = endpoint('a', async () => { calls++; if (mode === 'fail') throw new ProviderFailure('timeout','bad'); return 'ok' + calls; });
  const r = new ContinuityRouter([a, endpoint('b', async () => 'backup')], () => {}, () => now, 1, 30, { halfOpenSuccessThreshold: 2 });
  assert.equal((await r.execute(scope())).endpointId, 'b'); now = 200; mode = 'ok';
  await r.execute(scope()); assert.equal(r.health().find((h) => h.endpointId === 'a')?.state, 'half_open');
  await r.execute(scope()); assert.equal(r.health().find((h) => h.endpointId === 'a')?.state, 'closed');
});
test('failed half-open probe reopens breaker', async () => {
  let now = 100;
  const r = new ContinuityRouter([endpoint('a', fail('timeout')), endpoint('b', async () => 'backup')], () => {}, () => now, 1, 30);
  await r.execute(scope()); now = 200; await r.execute(scope());
  assert.equal(r.health().find((h) => h.endpointId === 'a')?.state, 'open');
});
test('invalid maxAttempts rejected with zero invocations', async () => {
  for (const maxAttempts of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
    let calls = 0; const r = new ContinuityRouter([endpoint('a', async () => { calls++; return 'x'; })]);
    await assert.rejects(r.execute(scope({ maxAttempts })), /maxAttempts/, String(maxAttempts)); assert.equal(calls, 0);
  }
});
test('invalid scope fields rejected with zero invocations', async () => {
  let calls = 0; const r = new ContinuityRouter([endpoint('a', async () => { calls++; return 'x'; })]);
  await assert.rejects(r.execute(scope({ dataClass: 'secret' as never })), /dataClass/);
  await assert.rejects(r.execute(scope({ allowFallback: 'yes' as never })), /allowFallback/);
  await assert.rejects(r.execute(scope({ neededCapabilities: 'tools' as never })), /neededCapabilities/);
  await assert.rejects(r.execute(null as never), /request/);
  assert.equal(calls, 0);
});
test('request snapshot is immutable and caller mutation cannot widen routing', async () => {
  let frozenSeen = false; let cCalls = 0;
  const req = scope();
  const a = endpoint('a', async (got) => { frozenSeen = Object.isFrozen(got) && Object.isFrozen(got.allowedEndpointIds); req.allowedEndpointIds.push('c'); req.allowedRegions.push('us'); throw new ProviderFailure('timeout','bad'); });
  const c = endpoint('c', async () => { cCalls++; return 'leaked'; }, { region:'us', priority: 0 });
  const r = new ContinuityRouter([a, endpoint('b', async () => 'backup'), c]);
  const res = await r.execute(req);
  assert.equal(res.endpointId, 'b'); assert.equal(cCalls, 0); assert.equal(frozenSeen, true);
});
test('server-derived policy overrides client-claimed tenant, region and endpoints', async () => {
  let cCalls = 0;
  const policy = { tenantId:'t1', allowedEndpointIds:['a','b'], allowedRegions:['ca'], dataClasses:['internal' as const], operations:['diagnose'], allowFallback:true, maxAttempts:2 };
  const mk = () => new ContinuityRouter([endpoint('a', fail('timeout')), endpoint('b', async () => 'backup'), endpoint('c', async () => { cCalls++; return 'leaked'; }, { region:'us' })], () => {}, () => Date.now(), 2, 30000, { serverPolicy: policy });
  const wide = scope({ allowedEndpointIds:['a','b','c'], allowedRegions:['ca','us'] });
  assert.equal((await mk().execute(wide)).endpointId, 'b'); assert.equal(cCalls, 0);
  await assert.rejects(mk().execute(scope({ tenantId:'t2' })), /policy/);
  await assert.rejects(mk().execute(scope({ dataClass:'confidential' })), /policy/);
});
test('concurrent tenants stay isolated', async () => {
  const seen: string[] = [];
  const a = endpoint('a', async (req) => { seen.push('a:' + req.tenantId); await delay(10); throw new ProviderFailure('timeout','bad'); });
  const b = endpoint('b', async (req) => { seen.push('b:' + req.tenantId); return 'for-' + req.tenantId; });
  const r = new ContinuityRouter([a, b]);
  const results = await Promise.all([r.execute(scope({ requestId:'r-t1', tenantId:'t1' })), r.execute(scope({ requestId:'r-t2', tenantId:'t2' })).catch((e: unknown) => e)]);
  assert.equal((results[0] as {value:string}).value, 'for-t1'); assert.ok(results[1] instanceof Error); assert.ok(!seen.some((s) => s === 'b:t2'));
});
test('invalid router options rejected', async () => {
  assert.throws(() => new ContinuityRouter([endpoint('a', async () => 'x')], () => {}, () => Date.now(), 2, 30000, { perAttemptTimeoutMs: 0 }), /perAttemptTimeoutMs/);
  assert.throws(() => new ContinuityRouter([endpoint('a', async () => 'x')], () => {}, () => Date.now(), 0, 30000), /breaker/);
});
