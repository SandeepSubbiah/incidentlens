# Sentinel continuity router — isolated prototype

**Status:** Merged into `main` via [PR #22](https://github.com/SandeepSubbiah/incidentlens/pull/22) on November 4, 2026. **Still an isolated prototype**: not imported by `src/llm.ts`, `src/server.ts` or any live inference path. Merge does not mean production activation.

## What exists

- `src/continuity/router.ts`: a provider-neutral adapter interface and a bounded, policy-constrained failover router.
- `test/continuity.test.ts`, `test/continuity-hardening.test.ts` and `test/continuity-stale.test.ts`: deterministic negative, concurrency, stale-completion and fault-injection tests. GitHub Actions on the final PR head reported 103/103 overall tests passing.
- Isolated per-endpoint in-memory circuit-breaker state, with an injectable clock for deterministic cooldown tests.
- Backup selection requires independently permitted tenant, data classification, region, operation, tool capabilities and endpoint ID.
- Refuses to switch models after a committed output or potential non-idempotent side effect, and refuses *any* new invocation of an already-committed operation (`outputCommitted` rejects with zero endpoint calls, whatever `safeToRetry` claims).
- Never fails over on authentication, billing, policy, security or unclassified errors.
- Emits request ID, endpoint ID, attempt and error kind only; no prompt contents or credentials.
- Telemetry callbacks are isolated: a throwing sink cannot change a provider result, a fallback decision or a breaker outcome. Failures are counted on `router.telemetryFailureCount`, so "could not report" is distinguishable from "nothing to report".
- Bounded execution: per-attempt (default 30s) and end-to-end (default 60s) deadlines plus caller `AbortSignal` cancellation, with timer/listener cleanup. An endpoint that ignores its signal is cut off by race and its late settlement is ignored.
- Half-open breakers admit exactly one concurrent probe lease; other requests fail over or skip. A configurable number of consecutive probe successes (`halfOpenSuccessThreshold`, default 1) is required to close the breaker; a failed probe reopens it.
- Breaker state has a generation that changes when it opens or closes. A call that started in an earlier generation still returns its result to its caller, but cannot change the breaker: a slow success from before an outage cannot close it, take the probe lease or skip the success threshold, and a slow failure from before recovery is not counted (`test/continuity-stale.test.ts`).
- Runtime input is validated (including finite-integer `maxAttempts`) and snapshotted deep-frozen before routing, so caller or endpoint mutation during a call cannot widen tenant, region, endpoint or capability routing.
- Optional trusted `serverPolicy` (constructor): when supplied, the request scope can only narrow it — tenant, data classes, operations, allowed endpoints/regions, fallback permission and `maxAttempts` are intersected with or checked against the server policy, never widened by client claims.

## What this DOES NOT do yet

- It does not change `src/llm.ts`, `src/server.ts`, the live War Room, governance or existing user traffic.
- No real Muse or alternative provider was invoked by these tests. Live failover and zero-downtime streaming recovery are NOT verified and are not claimed.
- No streaming resumption, durable checkpoints/effect journal, cross-instance breaker state, cost quota, retry backoff, weighted routing, deployments, health evaluation or automatic code changes.
- Without a constructor `serverPolicy`, request scope fields remain caller-supplied prototype inputs. Production integration must supply `serverPolicy` from authenticated server-side identity/policy and derive `outputCommitted`/`safeToRetry` from a durable tool-effect journal, never from untrusted client or model text.
- A JavaScript promise cannot be killed: a non-cooperative endpoint that ignores its `AbortSignal` may still perform a late effect after the router has timed out and failed over. Only the endpoint/adapter can guarantee it did not; adapters must honour the signal and use idempotency keys.
- No technology can promise outage-free continuation of a partially streamed model response across unrelated models.

## Next PRs (separate and reviewable)

1. Read-only Continuity Dashboard using simulated health and provenance, plus audit events.
2. Provider adapter integration behind a disabled-by-default flag. Add two *approved* test endpoints and validate privacy, compatibility, cost and auth restrictions. Measure switching latency/errors; do not claim invisible streamed continuation.
3. Durable session/tool-effect ledger with idempotency keys, output checkpoints and explicit partial-stream recovery UX.
4. Canary/blue-green release pipeline with readiness, graceful connection draining, staged traffic weights and measurable rollback.
5. Cases/Findings Explorer, custom reports and Evolution Ledger linking problems to reproducible tests and reviewed changes.

## Run

From a checkout of `main` after PR #22:

```powershell
node --test test/continuity.test.ts test/continuity-hardening.test.ts test/continuity-stale.test.ts
npm test
```

**Not yet integrated:** Connecting this router to production-like traffic requires separate review, end-to-end tests, privacy policy, provider adapters and a disabled-by-default rollout. Keep the working hackathon demo unchanged until that verification is complete.

Current feature inventory: [FEATURE_STATUS.md](FEATURE_STATUS.md).
