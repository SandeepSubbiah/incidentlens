# Evaluation protocol

What is measured today, how, and what is not yet measured. No live Muse results exist yet: the
Meta Model API returns `402 billing_not_configured` for this account.

## Layer 1 — Deterministic tests (implemented, run in CI)

`npm test` runs 53 tests with no network access and no API key. Models are scripted stand-ins,
so these tests measure IncidentLens's own machinery, not model quality.

| Area | Test file | Includes negative controls |
|---|---|---|
| Citation and patch checks, answer-key isolation, scoring | `core.test.ts` | Fabricated quote, wrong lines, missing file, red-herring diagnosis |
| Solo loop, both API formats | `agent-responses.test.ts`, `agent-messages.test.ts` | Fabricated citation rejected, then revised |
| War Room | `warroom.test.ts` | Rejected fact, skeptic gate, rejected patch |
| Guards | `guard.test.ts` | Tampered constitution, broken audit chain, seven blocked patch kinds, injection |
| Retrieval and registry | `skills.test.ts` | Own-case exclusion with a positive control |
| Model reflexes | `reflexes.test.ts` | Billing error not retried |
| Governance | `governance.test.ts`, `governance-races.test.ts` | Every refusal rule, races, partial commit, restarts |
| Self-repair | `heal.test.ts`, `seed.test.ts` | Policy-blocked patch, failed validation changes nothing |
| Access and paths | `access.test.ts`, `paths.test.ts` | Forged, expired, wrong-key codes; symlink escape; exposure without a secret |

## Layer 2 — Model evaluation on incidents (implemented, not yet run live)

`npm run eval` (solo) and `npm run eval -- --warroom` run every incident and score each report.

**Scoring, all deterministic, no model judge:**

| Metric | Definition |
|---|---|
| Root cause correct | Every `must_mention` synonym group in the hidden answer key appears in the summary or root cause |
| Fix target correct | The patch targets the answer key's `fix_artifact` |
| Citations verified | Evidence quotes found at the cited lines / evidence items |
| Patch lines found | Removed and context lines exist in the target |
| Patch applies | The diff applies to an isolated copy (`sandbox` in the report) |
| Cost, tokens, tool calls, seconds | From the model client's metering |

**Leakage controls (tested):**
- Agents cannot list or read `incident.json` or `ground-truth.json`.
- Case memory never returns the incident's own past case.
- Only verified, correct reports become retrievable cases, and runs made during self-repair
  validation never do.
- Test runs use temporary data directories.

**Known weaknesses:**
- Keyword groups can be satisfied by a report that mentions the right terms for the wrong
  reason. The fix-target check and verified citations reduce this but do not remove it.
- Five incidents, all authored alongside the system and used for development. There is no
  held-out set yet.
- No repetitions, so no variance or confidence intervals.

## Layer 3 — Self-repair validation (implemented, tested with a stub validator)

Before a Doctor patch becomes a change request, it is re-run on up to three canary incidents
(those failing under the current version plus a passing control), with the candidate overlaid
on the live registry. It passes only if nothing that passed now fails, at least as many pass as
before, and every citation verifies. Scores come from answer keys the Doctor cannot read. With
a real model this needs live inference, so tests use a stub validator.

## Protocol for the first live evaluation (to run when billing works)

1. Record model IDs, wire format, reasoning settings, skill revision and commit SHA. The run
   records already store these.
2. Run solo and War Room on all five incidents, three repetitions each.
3. Baseline: an unassisted single prompt with all evidence pasted in, no tools, no
   verification, scored by the same rules.
4. Ablations: War Room without the Skeptic gate, and without runbook retrieval. Both need small
   flags that do not exist yet (issue: live evaluation baseline).
5. Report per incident and mode: correct rate with n, citation verification rate, patch apply
   rate, cost per correct diagnosis, median and p95 duration.
6. Write new held-out incidents before any tuning on these results.

## Not measured yet

Claim-level groundedness beyond quote location, tool-outcome fabrication, abstention, task
drift, calibration, cross-provider comparison, and recognized benchmarks (SWE-bench-style). See
[SENTINEL_GAP_MATRIX.md](SENTINEL_GAP_MATRIX.md).
