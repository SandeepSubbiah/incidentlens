# Security assurance findings

> **Post-merge note (November 4, 2026):** The measurements below are the *historical
> 11:38–12:00 ET security pass*. The repository now also contains the separately tested
> continuity router merged in PR #22; GitHub Actions on its final head passed **103/103 tests**.
> That does not resolve the six open Sentinel smoke findings listed in this report.
> See [feature status](FEATURE_STATUS.md) and [router limitations](CONTINUITY_PROTOTYPE.md).


The first evidence-based security pass over IncidentLens, run on 2026-11-04 between 11:38 and
12:00 ET. It follows the Sentinel security assurance execution prompt of the same date: §1 audit,
§12 pre-deadline slice. That prompt is not in this repository.

**What this pass is.** It audits this repository's own code and runs 21 deterministic scenarios
against it. Every probe uses:
- temporary directories;
- a local scripted model;
- a synthetic API key.

**What it is not.** It is not a penetration test, not a scan of any external system and not a
security certification. Nine catalog groups are untested; they are listed below.

**Release status: safe to demonstrate. Not production-ready.** Details are at the end.

## Baseline

| Item | Value |
|---|---|
| HEAD before | `755ec4d`, clean, CI success |
| Toolchain | Node 24.18.0, npm 11.16.0, zero runtime dependencies |
| Models | `muse-wonder-1.0` (deep), `muse-spark-1.3` (fast), Responses API |
| `npm test` before | 53 of 53 pass |
| `npm test` after | 60 of 60 pass (6 new tests in `test/security.test.ts`, plus 1 for failed-run usage) |

## Trust boundaries

| Boundary | What crosses it | Existing controls | Tested here |
|---|---|---|---|
| Browser → HTTP API | Reads, decisions, live-run starts | Security headers, JSON-only POST, `SameSite=Strict` cookie, role checks | D01, D10, D13, G11, A10 |
| Access code → claims | Role, expiry, run budget | HMAC-SHA256, constant-time compare, login rate limit | D05, D08 |
| Evidence files → agent | Logs, traces, config, source (untrusted text) | Path containment, answer keys hidden, injection quarantine | C04/C08, C09, A02 |
| Agent → shared board | Quotes, claims | Quote verifier (±3 lines, `...` fragments) | B03, B04, H-EV1 |
| Model API → run record | Responses, usage, model names | Requested-model metering | B09a, B09b |
| Client disconnect → server run | Cancellation | Concurrency cap of 2; per-run step and cost budgets | F05 |
| Agent → governance | Change requests | Hash binding, quorum, veto, expiry, kill switch, roles | H01-H08, D16/D17 (existing suites) |
| Doctor → skills | Self-edits | Policy guard, constitution pin | H11-H13 (existing suite) |
| Self-changes → audit log | Hash-chained entries | Chain verification | G20 |
| Report → evaluation score | Diagnosis text | Hidden keyword groups | B19 |
| CI, npm, supply chain | Workflow, lockfile | Node built-ins only, no runtime dependencies | Not tested (G01-G05) |

## Results

`npm run sentinel:smoke` writes `eval/sentinel/smoke-latest.json`, which records the commit, a
dirty flag, the Node version and every scenario. It exits 1 while any scenario is FAIL or ERROR.

**Before the fixes, at `755ec4d`.** The 16 probe scenarios gave:
- 3 PASS: D13, C04/C08, G11.
- 13 FAIL.

The four existing-suite scenarios mis-reported in that run. The runner read the wrong summary
format, saw "0 passed, 0 failed", and reported FAIL. It now reports a suite it cannot read as
ERROR, and asks for TAP output explicitly.

**After the fixes:** 21 scenarios, **15 PASS, 6 FAIL, 0 ERROR.**

| ID | Scenario | Before | After |
|---|---|---|---|
| D10 | Cross-site GET starts a billable investigation (open mode) | FAIL: 70 model calls | PASS: 403, 0 calls; same-origin control still runs |
| D10b | Cross-site GET starts self-repair | FAIL | PASS |
| D08 | Two concurrent requests spend a 1-run code | FAIL: 2 of 2 started | PASS: 1 of 2; 2-run control starts both |
| D05 | Signed code with an invalid payload | FAIL: 3 of 3 accepted | PASS: 3 rejected; valid control accepted |
| D13 | Judge attempts admin actions | PASS | PASS |
| D01 | Reads without a code while access codes are on | FAIL | FAIL, risk accepted for the demo |
| C04/C08 | Answer keys and traversal through the evidence API | PASS | PASS |
| G11 | Security headers | PASS | PASS |
| A10 | Error bodies reveal server paths | FAIL: install path and user name | PASS |
| F05 | Client disconnect stops server work | FAIL: 7 more calls | FAIL, open |
| B09a | Completed run records the model that served it | FAIL | PASS |
| B09b | Failed run records spend and the model that served it | (not separate) | PASS |
| B04 | `...` stitches distant lines into one quote | FAIL | FAIL, open |
| B03 | Real quote cited for a false conclusion | FAIL | FAIL, known limit |
| B19 | A report negating every key term scores correct | FAIL | FAIL, known limit |
| H-EV1 | Rejected quote kept in full | FAIL: 543 cut to 200 | PASS |
| G20 | Deleting the newest audit entry is detected | FAIL | FAIL, open |
| H01-H08, D16/D17, H11-H13/A02, C09 | Existing governance, race, guard and path suites, executed | (runner error) | PASS: 4, 6, 7 and 2 tests |

**Live verification after the fixes:**
- **Plan B walkthrough in Chrome:** 19 of 19 checks pass. Real browser requests carry
  `Sec-Fetch-Site: same-origin`, and the new guard lets them through.
- **One live solo run on Muse through the browser** (inc-001, 11:53 ET): correct, $0.43.
  - Its record now carries `served: "muse-wonder-1.0"`, the model name Meta's API reported.
  - This is the first run record with that evidence. Records before 2026-11-04 11:53 ET show only
    the configured name.

## Findings

Severity is for this deployment as it is today: a local demo on loopback, or a hosted demo with
access codes. Every finding below was reproduced by a scenario; none is hypothetical.

### Fixed and verified

**SF-01 — A web page could start paid investigations on a local IncidentLens (D10, D10b).** High.
- **Surface:**
  - `GET /api/investigate/:id` and `GET /api/heal/run` start work on a plain GET.
  - In open mode (no `ACCESS_SECRET`, the local default) every caller is treated as admin.
  - So any site open in the same browser could fire such a GET at `localhost:5173`, for example
    from an `<img>` tag.
- **Reproduction:** the server accepted a request carrying `Sec-Fetch-Site: cross-site` and the
  scripted model received 35 calls. Whether a given browser delivers the request depends on its
  local-network protections; that part was not tested.
- **Fix:** live-run and self-repair GETs, and every POST, are refused when Fetch Metadata says
  `cross-site` or `same-site` (`src/server.ts`).
- **Residual risk:** requests without the header (curl, older browsers) are unaffected.
- **Verified:** `test/security.test.ts`, D10 and D10b; the walkthrough still passes.
- **Rollback:** revert the `startsWork`/`crossSite` lines.

**SF-02 — One access code could start more runs than its budget (D08).** Medium; hosted mode
only.
- **Surface:** the remaining-runs check and the charge were separated by an `await`, so two
  concurrent requests both passed. The first load of the usage file could also race.
- **Fix:** `reserveRun()` checks and counts in one synchronous step, and the usage load is one
  shared promise (`src/access.ts`).
- **Verified:** test, D08.
- **Rollback:** restore `runsLeft()` + `chargeRun()`.

**SF-03 — Signed codes with a malformed payload were accepted (D05).** Low; minting needs the
server secret.
- **Surface:** a code missing `runs` made `runsLeft()` return `NaN`, which never blocks, so the
  code had unlimited runs.
- **Fix:** `verifyToken` requires a non-empty `sub` and a numeric `runs ≥ 0`.
- **Verified:** test, D05.

**SF-04 — A 404 body revealed the install path and Windows user name (A10).** Low.
- **Fix:** filesystem errors now say only "not found".
- **Verified:** test, A10, using a detector that is first shown to catch a planted path.

**SF-05 — Rejected evidence was cut to 200 characters in run records (H-EV1).** Medium, because
rejections could not be audited.
- **Consequence:** this morning's live-results page claimed that two rejected quotes "ended in an
  ellipsis". The `…` was added by the recorder; the true cause is unrecoverable. That claim is
  now corrected in `EVALUATION_PROTOCOL.md`, `HACKATHON_SUBMISSION.md` and
  `SENTINEL_GAP_MATRIX.md`.
- **Fix:** the `fact_rejected` event keeps the whole quote up to 4,000 characters and flags
  anything longer.
- **Verified:** test, H-EV1. The UI shows only the reason, so nothing on screen changed.

**SF-06 — Run records named the configured model, not the model that answered (B09a, B09b).**
Medium for provenance.
- **Surface:**
  - A scripted model served every call, yet the record said only `muse-wonder-1.0`.
  - Failed runs recorded no usage at all, neither cost nor model.
- **Fix:**
  - `Usage` stores the `model` field from each API response as `served`.
  - Error events now carry `usage` (cost and per-model calls).
- **Verified:** two tests; B09a and B09b; one live Muse run whose record shows
  `served: "muse-wonder-1.0"`.

**SF-13 — A dropped connection on the fallback model ended the run.** Medium.
- **How found:** during the live continuity demo, after a successful failover, one
  `muse-spark-1.3` call failed with `fetch failed` and the run stopped.
- **Cause:** connection errors before any response were never retried, and on the backup there
  is nothing left to fail over to.
- **Fix:** one visible resend after 300 ms; timeouts are not resent; the error keeps its cause
  code.
- **Verified:** socket-cut tests in `test/continuity-demo.test.ts`, and a live rerun. See
  CONTINUITY_DEMO.md.

### Open: confirmed, deliberately not fixed before the deadline

These change live investigation or verification behaviour, so they wait until after the
recording.

**SF-07 — A disconnected client does not stop the server-side run (F05).** Medium. Issue #17.
- **Reproduction:** 7 more model calls happened in the 1.5 s after the client aborted.
- **Limits on cost today:**
  - at most 2 concurrent live runs;
  - a 30-step solo budget;
  - a $3 War Room budget.
- **Fix plan:** pass an `AbortSignal` from the response's `close` event into the tool loop and the
  War Room scheduler, and stop at the next turn boundary.

**SF-08 — An elided quote can stitch distant lines together (B04).** Medium. Issue #18.
- **Reproduction:** "HikariPool-1 - Start completed ... request timed out after 30000ms" verifies
  when cited as lines 1–33, although the two fragments are 18 lines apart.
- **Fix plan:** cap the distance between fragments, and record that a quote was elided.

**SF-09 — Deleting the newest audit entries is not detected (G20).** Medium. Issue #19.
- **Reproduction:** after the last entry is deleted, `verify()` still reports a valid chain of 2.
- **Why:** a hash chain cannot prove its own tail.
- **Fix plan:** anchor the head hash and length outside the log's own write path (issue #1).

**SF-10 — Read endpoints are public while access codes are on (D01).** Issue #20. Risk accepted for the
demo; High before any non-synthetic data.
- **Readable without a code:**
  - audit log;
  - change requests;
  - skill content;
  - evidence files;
  - run records.
- **Fix plan:** classify each endpoint's data and require a role for anything non-public
  (issue #2).

### Known limits, confirmed by test

**SF-11 — A verified citation does not verify the conclusion (B03).** A real GC-pause line cited
for "GC pauses caused the outage" verifies. The README already says this; claim-level checking is
issue #6.

**SF-12 — Keyword scoring passes a report that negates every key term (B19).** Issue #21. "Not Hikari pool
exhaustion, not the fraud call and not @Transactional: the cause is a DNS outage" scores correct.
The live 5-of-5 results stand as keyword scores, and the docs call them that. Case memory
promotes reports on this same score, so a wrong-but-keyword-matching report could become a
retrievable case; that effect was not tested.

### Not reproduced or not tested

- **Mixed scripted and Muse labels on one screen** (reported from a UI export): not reproduced.
  - The header comes from `/api/config` when the page loads; War Room lane labels come from the
    record being replayed.
  - The likely cause is a page left open while a different server started on the same port.
    That is unverified.
  - The replay banner, which names the record's model, now stays on screen.
- **Concurrent processes on the JSON state, and corrupted state files:** not tested. The server
  is single-process by design (issue #1).
- **Login rate limiting behind a proxy (per-IP keying), and access-code revocation:** not tested
  and not built.
- **CSP:** `style-src` allows `'unsafe-inline'`. Observed, not exploited.

## Untested domains

From the execution prompt's catalog, with the reason each is untested:

| Catalog IDs | Why untested |
|---|---|
| A01, A03–A15 | Live-model injection resistance beyond the inc-005 fixture needs an opt-in, cost-bounded Muse probe pack |
| B01–B20 except B03, B04, B09, B19 | Needs the claim verifier and focus governor (issues #6, #7) |
| C01–C03, C05–C07, C10–C20 | RAG poisoning, memory and multi-agent trust (issue #9) |
| D02–D04, D06–D07, D09, D11–D12, D14–D15, D18–D20 | Partly covered by `access.test.ts` and the governance suites; no revocation or tenants exist (issue #2) |
| E01–E20 | No compile/test sandbox, so generated code is never executed (issue #3) |
| F01–F04, F06–F20, cloud importers | Reflex tests exist; cloud importers are not built (issue #11) |
| G01–G10, G12–G19 | No SAST, dependency, secret or CI-permission scanner runs yet (issue #15) |
| H14–H20 | Held-out evaluation, decoys and alert flooding are not built (issues #10, #13) |
| I01–I12 | Discovery research not started |

## How actions are recorded

| Record | Location | What it proves | Gap |
|---|---|---|---|
| Run records | `runs/<incident>/*.json`; the committed live set is in `eval/live-2026-11-04/` | Every tool call, fact, rejection (now in full), requested and served model (from 11:53 ET), cost (now also for failed runs) | Not signed; an edited record replays as if real |
| Governance ledger | `data/governance/changes.json` | Each request's hash, risk, decisions with actor, role, reason and hash | Single process, local file (issue #1) |
| Audit log | `data/audit.jsonl` | Hash chain of self-changes and executions | Tail truncation undetected (SF-09) |
| Access usage | `data/access-usage.json` | Runs spent per code | No revocation |
| Evaluation | `eval/latest*.json` | Scores, citation counts, per incident | Keyword scoring (SF-12) |
| Security pack | `eval/sentinel/smoke-latest.json` | Commit, dirty flag, Node version, every scenario's result and observation | Offline and deterministic only |
| Tests | CI on every push | 69 tests | No live model in CI |

**Not recorded at all:**
- HTTP access, so who read what is unknown;
- denied cross-site requests (only the 403 response);
- reasoning tokens' content, by design.

## Next safest improvement

**SF-07, cancellation on disconnect.** It removes privilege (spend) rather than adding any, and
its test already exists (F05 turns PASS). It touches the live run loop, so do it after the video:

1. Pass an `AbortSignal` from the server.
2. Check it at each turn boundary.
3. Record the run as `cancelled`.
4. Rerun the smoke pack and one live run.

## Release status

| Level | Status | Why |
|---|---|---|
| Safe to demonstrate | **Yes** | Loopback only, synthetic incidents, cross-site starts refused, governance suites pass, live path verified after the fixes |
| Safe for an owned sandbox | With conditions | Needs `ACCESS_SECRET` and a decision on SF-10 |
| Ready for a limited pilot | **No** | SF-07 to SF-10 open; no sandboxed execution; no durable multi-process store |
| Production | **No** | See above, plus the untested domains |
