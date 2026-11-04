# Implementation gap matrix

Status as of 2026-11-04. Sentinel capabilities: [SENTINEL_GAP_MATRIX.md](SENTINEL_GAP_MATRIX.md). Phase P backlog: GitHub issues #1–#16. "Verified" means exercised by an automated test in `test/`, which runs in
CI on every push. "Mocked" means the model was a scripted stand-in. "Live" means exercised
against the real Meta Model API in the first live evaluation on 2026-11-04 (n = 1 per incident
and mode; see [EVALUATION_PROTOCOL.md](EVALUATION_PROTOCOL.md#live-results-2026-11-04)). Before
that morning the API returned `402 billing_not_configured`.

| Capability | Status | Evidence |
|---|---|---|
| Provider-neutral continuity router (PR #22) | **Merged/tested prototype, not integrated into live inference**. Tenant, data class, region, capabilities, deadlines, circuit breaker generation and safe retries are tested independently; no real provider adapter or streaming recovery. | `test/continuity.test.ts`, `test/continuity-hardening.test.ts`, `test/continuity-stale.test.ts` |
| Muse inference, Responses and Messages wires, tool calling | Implemented + mocked verified. **Live: works** on both models over the Responses API (12 recorded runs); a Messages API tool call returned `tool_use` on both | `agent-responses.test.ts`, `agent-messages.test.ts` |
| Fast/deep routing, circuit breaker, failover, Retry-After, parameter negotiation, billing errors not retried | Implemented + mocked verified. Live: routing works; the reflexes never fired, because no live call failed | `reflexes.test.ts` |
| Citation verification (fabricated, misplaced, missing file) | Implemented + verified | `core.test.ts` |
| Patch line check ("lines found in source") | Implemented + verified | `core.test.ts` |
| Patch applied to an isolated copy | Implemented + verified | `governance.test.ts` |
| Compile and run tests for a patch in a sandbox | **Missing** | |
| War Room: delegation, help requests, priority pre-emption and resume, skeptic gate, fix gate, model tiers | Implemented + mocked verified. Live: 6 runs, 5 of 5 root causes in the evaluation | `warroom.test.ts` |
| Live updates that pre-empt work | Implemented + mocked verified | `warroom.test.ts` |
| BM25 retrieval over runbooks; case memory that excludes the incident's own case | Implemented + verified | `skills.test.ts` |
| Semantic, vector or code-graph retrieval | **Missing** (no embeddings endpoint in the Meta Model API) | |
| Prompt-injection quarantine | Implemented + verified as an alert; **partial** as a defence | `guard.test.ts` |
| Constitution SHA-256 pin, tamper detection | Implemented + verified | `guard.test.ts` |
| Policy guard on AI-authored skill changes | Implemented + verified | `guard.test.ts`, `skills.test.ts` |
| Versioned skills, hot swap with no restart, rollback | Implemented + verified | `skills.test.ts` |
| Hash-chained audit log | Implemented + verified | `guard.test.ts`, `governance.test.ts` |
| Health indicators with a minimum sample of five runs | Implemented + verified | `heal.test.ts`, `seed.test.ts` |
| Doctor self-diagnosis with a model | Implemented + mocked verified. Live: one rehearsal in an isolated data directory found the seeded bad edit and rolled it back | `heal.test.ts` |
| Deterministic rollback rule with no model | Implemented + verified | `heal.test.ts`, `seed.test.ts` |
| Canary validation of a skill patch | Implemented; **partial**: tested with a stub validator. Not yet run live: the live Doctor chose a rollback, which needs no validation | `heal.test.ts` |
| Governance: hash-bound approval, quorum, separation of duties, veto, expiry, kill switch, A4 prohibition, execute once | Implemented + verified | `governance.test.ts` |
| Governance under concurrency and failure: conflicting changes (R7), veto racing execution, kill switch racing execution, partial-commit compensation (R9), restart during approval and during execution (R8) | Implemented + verified | `governance-races.test.ts` |
| Remediation execution | Simulated by design (isolated copy only) | `governance.test.ts` |
| Access codes, roles, run budgets, login rate limit, JSON-only POST (CSRF), security headers | Implemented + verified | `access.test.ts` |
| Fail closed when exposed without `ACCESS_SECRET` | Implemented + verified | `paths.test.ts` |
| Symlink and junction escape from a case | Implemented + verified | `paths.test.ts` |
| Durable, multi-instance, restart-safe state | **Partial**: JSON files, atomic writes, write-ahead execution record, restart recovery tested; no multi-instance locking | `governance-races.test.ts` |
| Security smoke pack (`npm run sentinel:smoke`) | Implemented: 21 offline scenarios; 15 PASS, 6 FAIL for open findings (SECURITY_ASSURANCE_FINDINGS.md) | `scripts/sentinel-smoke.ts`, `test/security.test.ts` |
| Model failover Wonder→Spark, circuit breaker, recovery, served-model record | Implemented + verified; **live**: injected Wonder outage, run completed on Spark, recovery after cooldown (n = 1, CONTINUITY_DEMO.md) | `continuity-demo.test.ts`, `reflexes.test.ts` |
| Evolution Ledger (faults become hash-chained improvement proposals) | Implemented + verified; proposal-only, no governance side effects | `continuity-demo.test.ts` |
| Streamed-response recovery, multi-instance HA, zero-downtime deploys | **Missing** | |
| Provenance labels (synthetic incident, live Muse or scripted model, simulated faults) on runs, replays, change requests, ledger entries, seeded runs, evaluation summaries and the UI | Implemented + verified; **live**: one Muse run stamped `synthetic · live · api.meta.ai`; older records show "source not recorded" | `provenance.test.ts` |
| Access-code revocation | **Missing** | |
| UI: solo, War Room, health, governance | Implemented; checked with Playwright scripts outside CI, offline and live (replay of a live War Room run, one live solo run). Responsive from 320px phones to 3840px monitors: no horizontal scroll at 11 widths, no text under 12px, 44px touch targets on phones (measured 2026-11-04) | |
| Offline demo mode | Implemented + smoke-tested | `scripts/offline-demo.ts` |
| Eval harness (`npm run eval`) | Implemented; **first live results** (n = 1): solo 5/5, War Room 5/5 root causes. Its "patches apply" count misses add-only patches that do apply | `src/eval.ts`, `eval/` |
| Image, video or voice evidence | **Missing** | |
| Hosted deployment | **Not deployed** | |
