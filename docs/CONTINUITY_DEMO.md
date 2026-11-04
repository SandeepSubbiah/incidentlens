# Continuity demo: outage, failover, recovery and the Evolution Ledger

This is the part of the Sentinel continuity specification that runs in IncidentLens today and
that can be shown on live Muse. It reuses the model reflexes already in `src/llm.ts` (breaker,
failover, fault injection). It does not use the separately tested router prototype that PR #22 later merged into `main`.

## What happens

1. **Inject a fault.** On the Health page, **Simulate deep-model outage** makes every
   `muse-wonder-1.0` call fail with a 503 for 3 minutes, before any network request.
2. **Fail over.** Each failed Wonder call is re-sent to `muse-spark-1.3`:
   - same provider, account and data, so no data goes anywhere new;
   - billing, auth and bad-request errors never fail over;
   - after 3 failures the circuit opens for 60 seconds and Wonder is skipped entirely.
3. **See it.**
   - Each switch appears in the trail as **Reflex · Failover** and **Circuit opened**.
   - The report says **Answered by muse-spark-1.3**. That name comes from the API's response, not
     from configuration.
   - The Health page shows the failure count and the active fault.
4. **Record it.**
   - The run is saved, and the **Evolution Ledger** adds a hash-chained entry: category, signal,
     whether the fault was simulated, outcome and cost, a link to the run record, a proposal and
     the regression test that covers it.
   - Entries only propose. None changes a skill, route or policy, or files a change request.
5. **Recover.** After **Clear faults** and the breaker cooldown, the next successful Wonder call
   shows **Reflex · Circuit closed**.

Prompt-injection lines quarantined in a run become a security entry the same way.

## Measured on live Muse, 2026-11-04 (n = 1 each)

| Run | Result |
|---|---|
| inc-001 solo, Wonder outage injected | Failover, circuit opened; report completed on Spark; 7/7 citations verified; diagnosis correct; 4 Spark calls, $0.050, 90 s |
| inc-001 solo, after clearing the fault | Circuit closed; 5 Wonder calls; 14/14 citations verified after one revision; $0.287, 93 s |
| Earlier attempt, Wonder outage injected | Failover worked, then one Spark call failed with `fetch failed` and the run ended. This found SF-13 below |

One run each is not a quality comparison between the models. The ledger entry proposes exactly
that comparison.

## Defect found by the live demo (SF-13, fixed)

**What happened:** a connection error before any response (`fetch failed`, a `TypeError`) was not
retried. On the primary model that triggers failover. On the backup it ended the run, because
there was nothing left to fail over to.

**Fix:** `post()` now resends such a call once after 300 ms, visibly ("Reflex · Connection retry").
- Timeouts are not resent.
- The error now keeps the underlying cause code, for example `fetch failed (ECONNRESET)`.
- A model call has no side effect here beyond cost.

**Test:** `test/continuity-demo.test.ts` cuts connections at the socket:
- one dropped connection is absorbed by the resend, with no failover;
- a persistent failure makes exactly two attempts per model, then stops.

## Simulated, not proven

- The outage is injected (`(chaos)` in every message, "simulated fault" in the ledger). No real
  Wonder outage has been observed.
- No streamed-response recovery. Failover happens between complete model calls only, so no
  partial output is ever stitched together.
- No zero-downtime or high-availability claim: there is one process and in-memory breaker state.
- Failover stays within one provider and account. Cross-provider routing with data-class,
  region and capability policy is what PR #22 prototypes; it is not wired in.

## Verification

| Check | Result |
|---|---|
| `npm test` | 65 of 65 at the time (69 with the provenance tests), including 5 continuity tests (outage, control, dropped connection, security entry, governance untouched and tampering detected) |
| Mutation check | Removing the ledger hook makes the outage test fail |
| `npm run sentinel:smoke` | Unchanged: 15 PASS, 6 FAIL (the open findings), 0 ERROR |
| Plan B walkthrough in Chrome | 19 of 19 |
| Layout | No horizontal scroll at 11 widths from 320 to 3840 px |
| Live Muse in Chrome | The two runs above |

## Rollback

The work is one merge commit on `main`. The release before it is tagged `pre-continuity-demo`.
- Revert with `git revert -m 1 <merge commit>`, or check out the tag.
- The ledger file (`data/evolution-ledger.jsonl`) is data. Deleting it removes only the
  opportunities.

## PR #22 merged: policy-aware router remains a separate prototype

[PR #22](https://github.com/SandeepSubbiah/incidentlens/pull/22) was merged into `main` on November 4, 2026. The code review identified observer failures, committed-output replay, absent deadlines, concurrent half-open probes, mutable routing scopes, and stale completions. Follow-up commits added targeted regression tests and fixes; the final PR-head GitHub Actions run passed **103/103 automated tests**.

**Important:** The new `src/continuity/router.ts` is not called by the live War Room or `src/llm.ts`. The live demonstration documented above uses the existing same-provider Meta Muse reflexes and an explicitly *simulated* Wonder outage.

Before integrating the new router, preserve the existing state machine, remove duplicate breaker authorities, derive permissions from trusted server policy, record side effects durably, require compatible approved provider adapters, and verify latency, cost, data classification, rollback and recovery with controlled experiments. No zero-downtime or mid-stream recovery guarantee is currently established.

See [continuity prototype](CONTINUITY_PROTOTYPE.md), [feature status](FEATURE_STATUS.md) and [implementation gaps](IMPLEMENTATION_GAP_MATRIX.md).
