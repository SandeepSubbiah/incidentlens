# IncidentLens capability evidence and delivery status

**Status date:** November 4, 2026. **Source of truth:** implementation and tests in the public repository, with limitations in the evaluation and threat-model documents. An item that is merged, unit-tested, simulated, or live-validated is not necessarily deployable.

## Meaning of each label

- **Live Muse validated:** Meta Muse was actually invoked with recorded output. Scope and sample size are stated.
- **Tested:** covered by automated deterministic tests, usually using a stub/scripted model. Does not imply production or live model testing.
- **Demonstrated with simulated fault:** real Muse inference responds to an explicitly injected failure; no real provider outage was observed.
- **Prototype / not integrated:** code is merged and testable independently, but not imported by the live inference path.
- **Partial:** feature exists with important limits or open findings.
- **Planned:** not implemented. Do not advertise as shipped.

## Evidence at a glance

| Evidence | Observed result | Interpretation |
|---|---|---|
| GitHub Actions on PR #22's final head `f1fec99` | **103 / 103 tests passed** | CI for the merged PR head; check newer commits independently |
| Solo evaluation: five author-written synthetic incidents | **5/5 root causes; 5/5 answer-key fix targets; 51/51 final citations** | One real Muse Wonder run per case, not an independent benchmark |
| War Room evaluation | **5/5 root causes; 4/5 answer-key fix targets; 58/58 final citations** | One real Wonder/Spark run per case; a different fix target was plausible but uncompiled |
| Live continuity demo with a *simulated* Wonder outage | Spark answered; the circuit opened; later Wonder recovered | Real model responses under an injected outage, not a live provider outage |
| Security smoke suite (last recorded November 4 pass) | **15 PASS, 6 FAIL, 0 ERROR of 21 scenarios** | Six findings remain open, not a security certification |
| Provider-neutral router | Unit-tested, merged by PR #22 | **Not connected** to `src/llm.ts` or the app's traffic |

Supporting documents: [evaluation](EVALUATION_PROTOCOL.md), [live failover demo](CONTINUITY_DEMO.md), [security findings](SECURITY_ASSURANCE_FINDINGS.md), [continuity router](CONTINUITY_PROTOTYPE.md), [implementation gaps](IMPLEMENTATION_GAP_MATRIX.md), and [threat model](THREAT_MODEL.md).

## Capability inventory

| Domain | Feature | Status | Implementation / evidence | Limitation |
|---|---|---|---|---|
| Investigation | Solo agent on Muse Wonder | Live Muse validated | `src/agent.ts`; recorded evaluation | Synthetic incidents; no external benchmark |
| Investigation | Six-agent War Room across Wonder and Spark | Live Muse validated | `src/warroom/`; recorded evaluation | More expensive than Solo on the five fixtures; no accuracy gain established |
| Evidence | Source-line citation check and gate before shared facts | Tested and live observed | `src/verify.ts`, `src/warroom/` | A real quote may be misinterpreted; not claim-level entailment |
| Reasoning | Skeptic review before conclusion | Tested and live observed | `src/warroom/` | Skeptic is still an AI; independent human review remains necessary |
| Retrieval | Versioned runbooks and lexical BM25 case retrieval | Tested | `src/skills/` | No embedding-based semantic or code-graph retrieval |
| Patching | Diff line check and isolated in-memory application | Tested and live observed | `src/verify.ts`, `src/sandbox.ts` | No compile, security scan or regression test of proposed Java patch |
| Governance | Risk classes A0–A4, distinct approvers, veto, expiry, kill switch, hash binding | Tested | `src/governance/` | Code remediation never deploys to a production service |
| Provenance | Live/scripted/synthetic provenance and recorded model identity | Tested | `src/provenance.ts`; UI labels | Historical records may lack provenance; they are labelled unknown |
| Self-healing | Doctor diagnoses a seeded bad skill and restores a validated version | Live Muse demonstrated | `src/heal/`, [continuity demo](CONTINUITY_DEMO.md) and [evaluation](EVALUATION_PROTOCOL.md) | Skills and runbooks only; no model-weight or production-code repair |
| Continuity | Same-provider Wonder→Spark failover with breaker/cost limits | Live Muse with simulated outage | `src/llm.ts` | Only between complete calls; single application instance |
| Continuity | Separate provider-neutral policy-based router | **Prototype, not integrated** | `src/continuity/router.ts`, tests, PR #22 | No live Muse adapter, cross-provider production routing or streaming recovery |
| Continuity | Timeout, callback isolation, half-open lease, stale result generation, safe retry checks | Tested **in isolated router** | `test/continuity*.test.ts` | No durable, cross-instance breaker or side-effect journal |
| Monitoring | IncidentLens health metrics, audit integrity, evolution opportunities | Partial | `src/heal/`, `src/guard/`, continuity demo | No enterprise telemetry backend or multi-instance HA |
| Security | Injection-pattern alert and read-only investigation tools | Tested | `src/guard/`, `src/tools.ts` | Not a comprehensive prompt-injection defense |
| Security | Deterministic Sentinel smoke checks | Partial | `npm run sentinel:smoke` | Six known failed scenarios in last documented run |
| UX | Incident dashboard, trail, source, governance and health panels | Implemented | `public/` | No comprehensive filters/custom report studio yet |
| UX | Evidence-backed capabilities and roadmap page | Added in the showcase PR | `public/capabilities.html` | Informational, not live telemetry |
| Reports | Full incident and security findings explorer / custom export | Planned | [Roadmap](ROADMAP.md) | Not shipped |
| Testing | Destination AI testing with independent source/evaluator model choices | Planned | Sentinel specification / backlog | Not shipped |
| Testing | Reproducible adversarial scenarios and held-out AI safety benchmarks | Partial/planned | Existing security smoke suite | Incomplete coverage and independent replication |
| Execution | Containerized code compile/test and safe production deployment | Planned | [Roadmap](ROADMAP.md) | Must not be advertised as current capability |
| Production | Zero-downtime multi-instance service, stream restoration, canary/blue-green releases | Planned | [Continuity prototype](CONTINUITY_PROTOTYPE.md) | No guarantee of invisible completion on a failed model stream |

## Public presentation rules

1. Label every demo as **live Muse**, **recorded replay**, **scripted model**, or **synthetic fault**.
2. Say **quotes verified at source locations**, not that all causal conclusions are proven.
3. Never describe the merged continuity prototype as automatically routing real user requests.
4. Never call an injected outage evidence of a provider-wide outage or guaranteed zero-downtime recovery.
5. Show evaluation denominators and known failures; the five authored cases are not generalizable.
6. Do not expose API keys, access codes, private incident logs, customer data or sensitive security findings in public screenshots.

## What to implement next

**Priority 1: Release accuracy and evidence.** Keep demo, README and status claims synchronized with CI; make live versus replay versus scripted provenance unmistakable.

**Priority 2: Security and reliability.** Address open Sentinel smoke findings, improve safe cancellation, verify endpoint effects, and add immutable audit anchoring where feasible.

**Priority 3: Integrated continuity.** Wire a single policy-governed router behind a disabled-by-default flag, using genuine backend credentials and measured failover tests, without duplicating independent breaker state.

**Priority 4: Operator interface.** Build an incident/finding taxonomy, searchable Case Explorer, report builder, and Evolution Ledger review queue, all backed by the same immutable evidence and run identifiers.

**Priority 5: Production-ready repairs.** Use disposable network-restricted build/test environments and human-approved canary/blue-green deployments with explicit rollback criteria.

Until these steps are implemented and verified, they are **potential**, not functionality.
