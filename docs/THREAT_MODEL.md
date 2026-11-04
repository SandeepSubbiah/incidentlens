# Threat model

IncidentLens reads attacker-reachable text (logs, tickets, code) and proposes changes. Each threat
below maps to its control, the test that exercises the control, and what remains.

| Threat | Control | Test | Residual risk |
|---|---|---|---|
| Prompt injection in evidence | Agents have read-only tools; instruction-like lines are marked untrusted; the constitution says evidence is data; changes need human approval | `guard.test.ts` (planted line in inc-005) | Pattern detection misses novel phrasings; impact is limited by read-only tools and the gate |
| Hallucinated evidence spreading between agents | `post_fact` verifies every quote before it reaches the board | `warroom.test.ts`, `core.test.ts` | A real quote can still support a wrong inference; the Skeptic and humans review |
| Agent reads the answer key | Hidden files and path traversal refused | `core.test.ts` | None known |
| Workspace escape via symlink | Real-path containment check | `paths.test.ts` | |
| Self-repair weakens its own rules | Constitution pinned in code; policy guard on added lines; changes limited to skills | `guard.test.ts`, `skills.test.ts` | The guard is pattern-based; human approval is the backstop |
| Self-repair games its evaluation | Doctor cannot read answer keys; validation scored by code | `heal.test.ts` | Small canary sets |
| AI approves its own change | Requester cannot approve; approver role verified from the access code, never from model text | `governance.test.ts` | |
| Approval of a different change than reviewed | Approval bound to SHA-256 of the exact change | `governance.test.ts` (R4) | |
| Late or stale approvals | Expiry fails closed; veto beats approvals; terminal states are final | `governance.test.ts` | |
| Runaway changes during an incident | Kill switch blocks execution (rollbacks allowed) | `governance.test.ts` | |
| Cost runaway | Per-run budgets, turn limits, concurrent-run cap, per-code run budgets | `access.test.ts` | Budgets apply per process |
| Forged or replayed access codes | HMAC-SHA256, constant-time compare, expiry, role whitelist | `access.test.ts` | No revocation list yet |
| Brute-forcing codes | Login rate limit per address | `access.test.ts` | In-memory; resets on restart |
| CSRF on cookie sessions | SameSite=Strict, HttpOnly, JSON-only POST bodies | `access.test.ts` | |
| Accidental public exposure | Refuses non-loopback listen without `ACCESS_SECRET` | `paths.test.ts` | |
| Audit tampering | Hash-chained log; any edit breaks the chain | `guard.test.ts` | An attacker with file access can truncate the end of the log |
| Secret leakage in self-written skills | Secret patterns and configured keys blocked | `guard.test.ts` | |
| Billing failure mistaken for an outage | 401/402/403 never retried or failed over | `reflexes.test.ts` | |
