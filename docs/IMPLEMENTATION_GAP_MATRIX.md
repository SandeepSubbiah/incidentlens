# Implementation gap matrix

Status as of 2026-11-04. "Verified" means exercised by an automated test in `test/`, which runs in
CI on every push. "Mocked" means the model was a scripted stand-in. No row is verified against
live Muse yet, because the Meta Model API returns `HTTP 402 billing_not_configured` for this
account (checked 2026-11-03 23:52 ET on both `muse-spark-1.3` and `muse-wonder-1.0`).

| Capability | Status | Evidence |
|---|---|---|
| Muse inference, Responses and Messages wires, tool calling | Implemented + mocked verified. **Live: blocked (402)** | `agent-responses.test.ts`, `agent-messages.test.ts` |
| Fast/deep routing, circuit breaker, failover, Retry-After, parameter negotiation, billing errors not retried | Implemented + mocked verified | `reflexes.test.ts` |
| Citation verification (fabricated, misplaced, missing file) | Implemented + verified | `core.test.ts` |
| Patch line check ("lines found in source") | Implemented + verified | `core.test.ts` |
| Patch applied to an isolated copy | Implemented + verified | `governance.test.ts` |
| Compile and run tests for a patch in a sandbox | **Missing** | |
| War Room: delegation, help requests, priority pre-emption and resume, skeptic gate, fix gate, model tiers | Implemented + mocked verified | `warroom.test.ts` |
| Live updates that pre-empt work | Implemented + mocked verified | `warroom.test.ts` |
| BM25 retrieval over runbooks; case memory that excludes the incident's own case | Implemented + verified | `skills.test.ts` |
| Semantic, vector or code-graph retrieval | **Missing** (no embeddings endpoint in the Meta Model API) | |
| Prompt-injection quarantine | Implemented + verified as an alert; **partial** as a defence | `guard.test.ts` |
| Constitution SHA-256 pin, tamper detection | Implemented + verified | `guard.test.ts` |
| Policy guard on AI-authored skill changes | Implemented + verified | `guard.test.ts`, `skills.test.ts` |
| Versioned skills, hot swap with no restart, rollback | Implemented + verified | `skills.test.ts` |
| Hash-chained audit log | Implemented + verified | `guard.test.ts`, `governance.test.ts` |
| Health indicators with a minimum sample of five runs | Implemented + verified | `heal.test.ts`, `seed.test.ts` |
| Doctor self-diagnosis with a model | Implemented + mocked verified. **Live: blocked** | `heal.test.ts` |
| Deterministic rollback rule with no model | Implemented + verified | `heal.test.ts`, `seed.test.ts` |
| Canary validation of a skill patch | Implemented; **partial**: tested with a stub validator, since real canaries need Muse | `heal.test.ts` |
| Governance: hash-bound approval, quorum, separation of duties, veto, expiry, kill switch, A4 prohibition, execute once | Implemented + verified | `governance.test.ts` |
| Remediation execution | Simulated by design (isolated copy only) | `governance.test.ts` |
| Access codes, roles, run budgets, login rate limit, JSON-only POST (CSRF), security headers | Implemented + verified | `access.test.ts` |
| Fail closed when exposed without `ACCESS_SECRET` | Implemented + verified | `paths.test.ts` |
| Symlink and junction escape from a case | Implemented + verified | `paths.test.ts` |
| Durable, multi-instance, restart-safe state | **Partial**: JSON files, atomic writes, one process | |
| Access-code revocation | **Missing** | |
| UI: solo, War Room, health, governance | Implemented; checked with Playwright scripts outside CI. Known issue: a 13px horizontal scroll on a 390px phone after a War Room replay | |
| Offline demo mode | Implemented + smoke-tested | `scripts/offline-demo.ts` |
| Eval harness (`npm run eval`) | Implemented; **no live results** (blocked) | `src/eval.ts` |
| Image, video or voice evidence | **Missing** | |
| Hosted deployment | **Not deployed** | |
