# Self-evolution

How IncidentLens changes its own behaviour, as implemented in `src/heal/*`,
`src/skills/registry.ts`, `src/guard/policy.ts` and `src/governance/changes.ts`. It improves
the system around Muse (skills, which are prompts and runbooks). It does not change Muse's
model weights.

## Mutable surface

| Can change through self-repair | Cannot change (enforced in code) |
|---|---|
| Role skills (`skills/roles/*.md`) | Constitution (`core/constitution.md`, SHA-256 pinned in code) |
| Runbook skills (`skills/runbooks/*/SKILL.md`) | Verifier, sandbox, tools, scoring, answer keys |
| | Policy guard, governance rules, access control, audit log |
| | Source code of any kind |

The registry rejects AI-authored versions that fail the policy guard, and it rejects all AI
changes if the constitution's hash no longer matches.

## Lifecycle as built

Mapped onto the specification's stages. Stages marked "not built" are absent, not partial.

| Stage | Implementation | Evidence |
|---|---|---|
| Observe | Every run is recorded with its skill versions, verification outcomes, tool errors and score | `src/agent.ts`, `src/warroom/run.ts` |
| Detect | Indicators over the last eight runs (accuracy, failures, citation rejection, tool errors); breaches count only with at least five runs | `src/heal/health.ts`, `test/seed.test.ts` |
| Triage | A self-case is written: indicator table, skill-version diffs, failing-run transcripts, active skills | `buildSelfCase`, `test/heal.test.ts` |
| Reproduce | **Not built** | |
| Hypothesize and propose | The Doctor investigates the self-case under the same citation rules and proposes a rollback, a minimal patch to one skill, or nothing. Without a model, a fixed rule rolls back an unvalidated change that every failing run after it used | `src/heal/doctor.ts` |
| Policy gate | Added lines checked for rule overrides, secret disclosure, exfiltration, edits outside skills, new URLs, and changes over 50% | `src/guard/policy.ts`, `test/guard.test.ts` |
| Isolated test and independent evaluation | Candidate overlaid on the live registry and re-run on canary incidents; scored against hidden answer keys | `validateWithCanaries`, `test/heal.test.ts` (stub) |
| Approval | Validated patch becomes an A1 change request that needs one human admin who is not the Doctor; rollbacks are pre-authorized | `src/governance/changes.ts` |
| Shadow and canary deployment | **Not built.** Promotion is all-at-once on the next run | |
| Promote | Registry activation, live on the next run, no restart; conflicts with newer versions refused (R7) | `test/governance-races.test.ts` |
| Monitor and revert | The next health assessment can trigger a rollback. No automatic post-promotion watch window | `test/seed.test.ts` |
| Learn | Verified, correct reports become retrievable cases (never the incident's own) | `test/skills.test.ts` |

## Separation of duties

| Role | Who | Can see answer keys | Can activate |
|---|---|---|---|
| Proposer | Doctor (model) or reflex rule (code) | No | No |
| Policy gate | `checkSkillPatch` (code) | No | No |
| Evaluator | `validateWithCanaries` (code driving the solo agent) | Scoring only, outside the model | No |
| Approver | Human admin, by signed access code | — | Yes, through governance |

**Limitation:** the evaluator runs the same model as the proposer, so it is independent in
scoring but not in model. A second provider or a frozen reference model would strengthen this.

## Demonstration modes

- **Seeded regression.** Pushes a bad skill edit and five failing run records marked
  `synthetic: true`. The health view shows how many synthetic runs it counts. Self-repair then
  rolls back through a pre-authorized change request (`test/seed.test.ts`).
- **Live.** The same loop driven by real runs. It needs working Muse inference, which does not
  exist yet.

## Not built

Reproduction step, multiple competing candidates, held-out evaluation split, shadow traffic,
staged canary, statistical promotion thresholds, post-promotion monitoring window, a second
evaluator model. Tracked as GitHub issues labelled `phase-p`.
