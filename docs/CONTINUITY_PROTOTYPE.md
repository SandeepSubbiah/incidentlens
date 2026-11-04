# Sentinel continuity router — initial isolated prototype

**Status:** Experimental, not wired into production inference or the existing Muse agent runtime. Implemented on a feature branch only.

## What exists

- `src/continuity/router.ts`: a provider-neutral adapter interface and a bounded, policy-constrained failover router.
- `test/continuity.test.ts`: 12 deterministic tests, exercised locally with Node 22 type stripping (target project runs Node >=24).
- Isolated per-endpoint in-memory circuit-breaker state, with an injectable clock for deterministic cooldown tests.
- Backup selection requires independently permitted tenant, data classification, region, operation, tool capabilities and endpoint ID.
- Refuses to switch models after a committed output or potential non-idempotent side effect.
- Never fails over on authentication, billing, policy, security or unclassified errors.
- Emits request ID, endpoint ID, attempt and error kind only; no prompt contents or credentials.

## What this DOES NOT do yet

- It does not change `src/llm.ts`, `src/server.ts`, the live War Room, governance or existing user traffic.
- No real Muse or alternative provider was invoked by these tests. Live failover is NOT verified.
- No end-to-end deadlines, streaming resumption, durable checkpoints, cross-instance breaker state, cost quota, retry backoff, weighted routing, deployments, health evaluation or automatic code changes.
- `safeToRetry` and provider allowlists are trusted inputs in this prototype. Before production integration, derive them from server-side authenticated policy and durable tool-effect records, never from untrusted client or model text.
- The term 'half_open' is only a health indicator after cooldown; this prototype does not yet serialize half-open probe concurrency.
- No technology can promise outage-free continuation of a partially streamed model response across unrelated models.

## Next PRs (separate and reviewable)

1. Read-only Continuity Dashboard using simulated health and provenance, plus audit events.
2. Server-derived policy and typed validation; backoff, deadlines, circuit-probe lease, telemetry and cancellation.
3. Provider adapter integration behind disabled-by-default flag. Add two *approved* test endpoints and validate privacy, compatibility, cost and auth restrictions.
4. Durable session/tool-effect ledger with idempotency keys, output checkpoints and explicit partial-stream recovery UX.
5. Canary/blue-green release pipeline with readiness, graceful connection draining, staged traffic weights and measurable rollback.
6. Cases/Findings Explorer, custom reports and Evolution Ledger linking problems to reproducible tests and reviewed changes.

The full engineering scope is specified in `INCIDENTLENS_CONTINUITY_ASSURANCE_EVOLUTION_SPEC.md` distributed separately for Claude Code handoff; do not mistake that scope for implemented functionality.

## Run

From a checkout of this branch:

```powershell
node --test test/continuity.test.ts
npm test
```

Do not merge during the hackathon release without reviewing CI and ensuring its demo remains unchanged.
