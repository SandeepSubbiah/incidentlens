import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuityRouter, ProviderFailure, type Endpoint, type RequestScope } from '../src/continuity/router.ts';

// A request that started before the breaker changed state must not change it when it finishes:
// otherwise a slow success from before an outage closes an open breaker, steals a half-open probe
// lease, or skips the half-open success threshold (Codex review on PR #22, reproduced here first).

const scope = (requestId: string): RequestScope => ({ requestId, tenantId: 't1', dataClass: 'internal', operation: 'diagnose', neededCapabilities: [], allowedEndpointIds: ['a'], allowedRegions: ['ca'], primaryEndpointId: 'a', allowFallback: false, safeToRetry: true, outputCommitted: false });

// Endpoint 'a' whose calls stay pending until the test settles them, in order of invocation.
function controllable() {
  const calls: { resolve: (v: string) => void; reject: (e: unknown) => void }[] = [];
  const endpoint: Endpoint<string> = {
    id: 'a', region: 'ca', enabled: true, priority: 0, allowedTenants: ['t1'], dataClasses: ['internal'], operations: ['diagnose'], capabilities: [],
    invoke: () => new Promise<string>((resolve, reject) => calls.push({ resolve, reject })),
  };
  return { endpoint, calls };
}
const tick = () => new Promise((r) => setImmediate(r));
const state = (r: ContinuityRouter<string>) => r.health()[0].state;

async function openWithSlowRequestPending(halfOpenSuccessThreshold = 1) {
  let now = 100;
  const { endpoint, calls } = controllable();
  const router = new ContinuityRouter([endpoint], () => {}, () => now, 2, 30, { halfOpenSuccessThreshold });
  const slow = router.execute(scope('slow'));
  const f1 = router.execute(scope('f1'));
  const f2 = router.execute(scope('f2'));
  await tick();
  calls[1].reject(new ProviderFailure('unavailable', 'down'));
  calls[2].reject(new ProviderFailure('unavailable', 'down'));
  await Promise.allSettled([f1, f2]);
  assert.equal(state(router), 'open', 'setup: two failures open the breaker');
  return { router, calls, slow, setNow: (t: number) => { now = t; } };
}

test('control: a success from the same breaker state still resets the failure count', async () => {
  const { endpoint, calls } = controllable();
  const router = new ContinuityRouter([endpoint], () => {}, () => 100, 3, 30);
  const f = router.execute(scope('f'));
  await tick();
  calls[0].reject(new ProviderFailure('unavailable', 'down'));
  await f.catch(() => {});
  assert.equal(router.health()[0].consecutiveFailures, 1);
  const ok = router.execute(scope('ok'));
  await tick();
  calls[1].resolve('fine');
  await ok;
  assert.equal(router.health()[0].consecutiveFailures, 0);
});

test('a stale success during cooldown does not close an open breaker', async () => {
  const { router, calls, slow } = await openWithSlowRequestPending();
  calls[0].resolve('late');
  assert.equal((await slow).value, 'late', 'the caller still gets its result');
  assert.equal(state(router), 'open');
});

test('a stale success cannot take the half-open probe lease', async () => {
  const { router, calls, slow, setNow } = await openWithSlowRequestPending();
  setNow(131);
  const probe = router.execute(scope('probe'));
  await tick();
  assert.equal(calls.length, 4, 'the probe is the only new call');
  calls[0].resolve('late');
  await slow;
  const intruder = router.execute(scope('intruder')).then(() => 'resolved', (e: Error) => e.message);
  await tick();
  assert.equal(calls.length, 4, 'while the probe is in flight, no other call reaches the endpoint');
  assert.equal(await intruder, 'no healthy approved endpoint');
  calls[3].resolve('probe ok');
  await probe;
  assert.equal(state(router), 'closed', 'the probe itself still closes the breaker');
});

test('a stale success does not bypass the half-open success threshold', async () => {
  const { router, calls, slow, setNow } = await openWithSlowRequestPending(2);
  setNow(131);
  const probe = router.execute(scope('probe'));
  await tick();
  calls[0].resolve('late');
  await slow;
  calls[3].resolve('probe ok');
  await probe;
  assert.equal(state(router), 'half_open', 'one probe success of two required');
});

test('a stale failure does not reopen a breaker that a probe has closed', async () => {
  const { router, calls, slow, setNow } = await openWithSlowRequestPending();
  setNow(131);
  const probe = router.execute(scope('probe'));
  await tick();
  calls[3].resolve('probe ok');
  await probe;
  assert.equal(state(router), 'closed');
  calls[0].reject(new ProviderFailure('unavailable', 'late failure'));
  await slow.catch(() => {});
  assert.equal(router.health()[0].consecutiveFailures, 0, 'a failure from before recovery is not counted');
});
