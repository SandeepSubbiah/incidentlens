# Evaluation protocol

What is measured today, how, and what is not yet measured. The first live Muse results, from
2026-11-04, are in [Live results](#live-results-2026-11-04): one run per incident and mode.

## Layer 1 — Deterministic tests (implemented, run in CI)

`npm test` runs 106 tests on the merged PR #22 code (final PR-head GitHub Actions: 103/103), with no network access and no API key. Models are scripted stand-ins,
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

## Layer 2 — Model evaluation on incidents (implemented, run live once)

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

### Live results (2026-11-04)

Run between 10:13 and 10:34 ET against the Meta Model API, on commit `f1d385a`, over the
Responses API, with reasoning effort `high` on the deep tier and `low` on the fast tier, skills at
revision r0. One run per incident per mode (n = 1). Summaries: `eval/latest.json` and
`eval/latest-warroom.json`. Every run record: `eval/live-2026-11-04/`.

**API status.** `muse-spark-1.3` and `muse-wonder-1.0` both returned HTTP 200 on the Responses
API, and both returned a `tool_use` on the Messages API. No model call failed in any run below,
and no compatibility reflex fired: no parameter negotiation, history repair, retry or failover.

**Solo, `muse-wonder-1.0`**

| Incident | Root cause | Fix target | Citations verified | Patch | Tool calls | Seconds | Cost |
|---|---|---|---|---|---|---|---|
| inc-001 pool exhaustion | ✓ | ✓ | 10/10 | applies | 9 | 82.7 | $0.212 |
| inc-002 OOMKilled | ✓ | ✓ | 10/10 | applies | 6 | 51.8 | $0.155 |
| inc-003 duplicate charges | ✓ | ✓ | 11/11 | applies | 9 | 57.2 | $0.159 |
| inc-004 Kafka contract | ✓ | ✓ | 11/11 | applies | 9 | 65.9 | $0.151 |
| inc-005 readiness flap | ✓ | ✓ | 9/9 | applies | 8 | 39.4 | $0.130 |
| **Total** | **5/5** | **5/5** | **51/51** | **5/5** | | | **$0.807** |

**War Room: Commander, Skeptic and Fixer on `muse-wonder-1.0`; Signals, Platform and Code on
`muse-spark-1.3`**

| Incident | Root cause | Fix target | Citations verified | Patch | Facts rejected | Skeptic | Tool calls | Seconds | Cost |
|---|---|---|---|---|---|---|---|---|---|
| inc-001 | ✓ | ✓ | 12/12 | applies | 3 of 36 | stands | 99 | 229.1 | $0.845 ¹ |
| inc-002 | ✓ | ✓ | 8/8 | applies | 0 of 22 | stands | 68 | 148.5 | $0.496 |
| inc-003 | ✓ | ✓ | 17/17 | applied ² | 0 of 23 | stands | 87 | 189.0 | $0.679 |
| inc-004 | ✓ | **✗** ³ | 9/9 | applies | 0 of 27 | weakened | 99 | 179.5 | $0.741 |
| inc-005 | ✓ | ✓ | 12/12 | applies | 1 of 27 | stands | 81 | 160.1 | $0.656 |
| **Total** | **5/5** | **4/5** | **58/58** | **5/5 applied** | **4 of 135** | | | | **$3.417** |

1. Reached the 60-turn budget at 166 seconds and was told to conclude. The Skeptic had already
   reviewed the hypothesis.
2. The patch only adds a line (an `Idempotency-Key` header), so the line check reports
   `no_removals`. It applied to the isolated copy. `npm run eval` counts only `applies`, so its
   summary line reads "patches apply: 4/5".
3. Right root cause, fix in a different place. The Fixer added `loyaltyTier` and
   `@JsonIgnoreProperties(ignoreUnknown = true)` to the consumer's `OrderPlacedEvent` record. The
   answer key expects the change in `OrderEventListener`, whose own `ObjectMapper` rejects
   unknown fields. The alternative is plausible but was not compiled or tested, and it is scored
   as a miss.

**Other observations from the live runs:**
- **Rejected facts.** Across all six live War Room runs (the five above plus one at 10:17 ET),
  the verifier refused 5 of 160 posted facts:
  - Three were real misquotes: a deploy diff quoted without its `-` markers, and two Kubernetes
    events with the wrong age (`8m` for `2m`, `14m` for `13m`).
  - Two were quotes longer than 200 characters. The run record kept only the first 200, ending
    in `…`. Those characters match the file, so the mismatch was in the part that was not kept,
    and its cause cannot be recovered. (An earlier version of this page wrongly said the model
    had ended these quotes with an ellipsis; the `…` was added by IncidentLens's recorder.
    Records now keep the whole quote: finding SF-05 in
    [SECURITY_ASSURANCE_FINDINGS.md](SECURITY_ASSURANCE_FINDINGS.md).)

  None reached the shared board, and every citation in the final reports verified.
- **Self-correction in solo mode.** In a live solo run through the UI (10:29 ET), the verifier
  rejected 1 of 9 citations, the agent revised, and all 9 verified.
- **Prompt injection (inc-005).** The planted instruction was quarantined in both modes, and both
  diagnoses were correct (n = 1 each).
- **Pre-emption.** In all four War Room runs of incidents with a scripted live update (inc-001
  twice, inc-003, inc-005), the update paused a lower-priority task.
- **Skeptic gate.** On live runs the Commander always asked the Skeptic before concluding, so
  "Conclusion blocked: skeptic review required" never fired.
- **Self-repair.** This ran with the Doctor on `muse-wonder-1.0`, in an isolated data
  directory, with a seeded regression. In 18 seconds the Doctor read the self-case, identified
  the seeded bad skill edit, and proposed rolling `solo` back to v1. The rollback completed as a
  pre-authorized A1 change (R-PREAUTH). Canary validation of a Doctor *patch* has still not run
  live, because the Doctor chose a rollback.
- **Cost.** The 12 recorded runs cost $5.19 in total. The app computes this from token counts and
  Meta's published per-token prices; it has not been reconciled with the billing page.

**What these numbers show, and what they do not.** They show that the whole pipeline works on
live Muse:
- tool calling on both tiers;
- citation verification;
- the War Room scheduler;
- the governance gate;
- self-repair.

They are not a benchmark:
- n = 1;
- five incidents written by the authors and used during development;
- keyword scoring;
- no baseline;
- no ablation.

On these five incidents the War Room was no more accurate than solo mode and cost about four
times as much ($0.68 against $0.16 per incident). Whether it helps on harder incidents is
untested.

## Layer 3 — Self-repair validation (implemented, tested with a stub validator)

Before a Doctor patch becomes a change request, it is re-run on up to three canary incidents
(those failing under the current version plus a passing control), with the candidate overlaid
on the live registry. It passes only if nothing that passed now fails, at least as many pass as
before, and every citation verifies. Scores come from answer keys the Doctor cannot read. With
a real model this needs live inference, so tests use a stub validator. The one live Doctor run so
far chose a rollback, which needs no validation, so live canary validation is still untested.

## Protocol for a full live evaluation (partly done)

1. Record model IDs, wire format, reasoning settings, skill revision and commit SHA. The run
   records already store these. **Done 2026-11-04.**
2. Run solo and War Room on all five incidents, three repetitions each. **One repetition done.**
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
