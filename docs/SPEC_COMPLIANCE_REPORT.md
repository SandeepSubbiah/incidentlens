# Spec compliance report

Progress against three specifications, as of 2026-11-04 00:45 ET, HEAD `71c1941` plus the
commit that adds this file:

1. `INCIDENTLENS_CLAUDE_CODE_MASTER_PROMPT.md`, the original master prompt.
2. `INCIDENTLENS_SENTINEL_CLAUDE_CODE_ADDENDUM.md`, the Sentinel addendum.
3. `INCIDENTLENS_MASTER_PROMPT_V2_WITH_SENTINEL.md`, which is spec 1 plus spec 2 verbatim. Its
   status is the union of both. It refers to itself at a `docs/` path, but it is not in this
   repository.

**Bottom line:** none is fully complete. Spec 1's hackathon phase (H0) is complete except
live Muse runs (blocked) and the video and submission (the owner's). Spec 2's own hackathon
slice is mostly not done. The Phase P work of both is tracked as GitHub issues #1–#16.

## Legend: real versus mocked

| Status | Meaning |
|---|---|
| **Done (mocked)** | Built and passing in CI with a **scripted stand-in model** or no model. Not evidence of Muse behaviour |
| **Done (no model)** | Built and passing in CI; the capability involves no model at all (governance, access, guards) |
| **Built** | In code, no automated test |
| **Partial** | Some of it exists; the gap is stated |
| **Missing** | Not built |
| **Blocked** | Needs live Muse inference: `402 billing_not_configured` on both models, last checked 00:37 ET |

**No test in this repository has ever run against live Muse.** CI on `71c1941`: 53 of 53 pass.
The demo walkthrough in Chrome (offline mode, scripted model): 19 of 19 checks pass.

## Spec 1: original master prompt

### Hackathon phase (H0)

| Requirement | Status |
|---|---|
| Audit, gap matrix, decision log | Done |
| Confirm Muse access, document the blocker | Done; blocked and labelled everywhere |
| One full investigation with visible evidence and citation checks | Done (mocked) |
| Save a real Muse run | **Blocked** |
| A claim visibly rejected, then corrected | Done (mocked): made-up fact rejected, bad patch rejected |
| Governance: deny, approval, veto, expiry | Done (no model) |
| Self-repair detection and rollback, labelled | Done (no model): seeded synthetic runs, marked `synthetic: true` |
| README, license (MIT), clean clone, public repo | Done |
| Submission pack and 3-minute script | Done; Plan B says on camera that the model is scripted |
| Video and form submission | Not done: owner |

### Sections

| Section | Status | Gap |
|---|---|---|
| §5 Typed, runtime-validated contracts | Partial | TypeScript types only; only change requests follow the spec |
| §6 P0–P4 incident priority, A0–A4 action risk | Partial | A0–A4 done; incidents use SEV-1/2 |
| §7 Approval engine | Partial | **Done (no model):** hash binding, quorum, separation of duties, veto, expiry, kill switch, execute once, conflicts R7, restart R8, partial commit R9. **Missing:** hold, revoke, release; preflight, scheduled, suspended states; 8 roles (2 exist); break-glass; dependency graphs |
| §7 Eleven listed test cases | Partial | 10 done (no model); a forged role written inside a log has no fixture |
| §8 Provider-neutral interface | Partial | Two wire formats, one provider |
| §9 Engineering RAG | Partial | BM25 plus case memory with leakage controls; no vector search, code graph, versioning or contradiction search |
| §10 AI coding lab | Missing | |
| §11 Loops | Partial | Reflexes done (mocked); reflection done (mocked) without a skeptic for the Doctor; evolution missing |
| §12 Evaluation | Partial | Harness built; live results blocked; no baselines, ablations or benchmarks |
| §13 Security | Partial | See THREAT_MODEL.md; no container sandbox, egress allowlist or revocation |
| §14 Execution and recovery | Partial | Skill rollback and compensation done; remediation simulated |
| §15 Dashboard (12 sections) | Partial | About 4 of 12 |
| §16 Directory layout | Not followed | Existing layout kept, as the spec allows |
| §18 Production-candidate gate | Not met | Not expected for the hackathon |
| §19 Eleven documents | Done | |
| §21 Step 6: issues and decision records | Done | #1–#16, DECISION_LOG.md |

**§18 negative tests:** made-up citation, misleading log instruction, invalid path, answer-key
request, forged credential, expired decision, conflicting changes, billing failure, simulated
outage, wrong patch context, failed canary (stub validator) and partial rollback are all done.
Arbitrary command is not applicable (no command tool). Stalled agent is built but untested.
Corrupted memory is missing.

## Spec 2: Sentinel addendum

### Sentinel hackathon slice (§18 H)

| Item | Status |
|---|---|
| Re-verify Muse access | Done: still 402 |
| Sentinel Assurance Panel (five categories) | **Missing** |
| Deterministic pack: S01, S02, S06, S08, S14, S15, S20, S24 plus a negative control | **Partial.** S08 done; S01, S02, S06 and S20 partial; S14, S15 and S24 missing; no `npm run sentinel:test` |
| Full assurance sequence | Partial (mocked); claim-level rejection missing |
| Video and submission | Owner |

### Sections

| Section | Status |
|---|---|
| §0 Operating rules | Followed |
| §1 Sentinel as a named product | Missing; some capabilities exist under other names |
| §2 Full threat model with data-flow diagram | Partial (THREAT_MODEL.md) |
| §3 Control catalog | Missing |
| §4 Test suites | Partial: citations, injection, governance, resilience |
| §5 Focus & Truth lab | Missing beyond citation checks and budgets |
| §6 Cloud posture | Missing |
| §7 Identity and insider risk | Partial: codes, roles, separation of duties |
| §8 Decoys | Missing |
| §9 Policy and stop/go gate | Mostly done (no model); hold and revoke missing |
| §10 Self-repair state machine | Partial |
| §11 Provider adapters and benchmarks | Missing |
| §12 Container sandbox and supply-chain scans | Missing |
| §13 Schemas | Missing |
| §14 Sentinel dashboard | Missing |
| §15 Telemetry | Partial; no OpenTelemetry |
| §17 Scenarios S01–S30 | 12 done, 6 partial, 11 missing, 1 not applicable (SENTINEL_GAP_MATRIX.md) |
| §19 Seven documents plus a verification report | 1 of 8 (gap matrix) |

### Safety rules (§16)

| Status | Rules |
|---|---|
| Done (no model) | 1, 2 (no "revoked" state yet), 3, 5, 9, 10, 20 |
| Built, untested | 6, 7, 16, 17, 19 |
| Partial | 4, 8, 11, 12, 18 |
| Missing | 13 (cancellation: a disconnected client does not stop a run) |
| Not applicable yet | 14, 15 |

## Strongest parts

1. Citation-gated War Room, a Skeptic gate, and urgent work pre-empting other work.
2. A governance gate whose race tests failed against the earlier code; three defects fixed.
3. Self-repair that cannot see its grader or edit its constitution, with human approval.
4. Honest labelling: "not Muse", synthetic, simulated.
5. 53 tests in CI, clean clone, and docs that map claims to tests.

## Largest gaps, in order

1. No live Muse run (billing).
2. Sentinel hackathon slice: the Assurance Panel and the test pack.
3. Claim-level verification (S14, S15) and drift detection (S24).
4. No compile or test of patches in a container.
5. Durable state, identity, and hold and revoke decisions.
