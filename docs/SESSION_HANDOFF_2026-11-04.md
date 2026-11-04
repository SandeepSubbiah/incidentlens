# Session handoff — 2026-11-04 ~00:50 ET

For whoever continues: a person, or Claude Code after the usage reset at 2:10 AM ET.

> **Update, 10:50 ET.** Meta billing works: HTTP 200 on both models from 10:13 ET. The first
> live evaluation is recorded in `docs/EVALUATION_PROTOCOL.md` (Live results), and the demo
> script now defaults to Plan A (live Muse). The 402 lines below are historical.
**Deadline: Wednesday 2026-11-04, 9:00 PM ET.** Submission form:
https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit. Requirements per the
organizer email: an open-source GitHub repo (mandatory) and a 3-minute demo video.

## Repository state

- Repo: https://github.com/SandeepSubbiah/incidentlens (public, MIT), branch `main`.
- Local: `C:\Users\Dell\Documents\Source\Meta\hackathon\incidentlens`.
- HEAD: the commit that adds this file, on top of `71c1941`. Run `git log --oneline -3` to
  confirm. The working tree was clean before this commit, and every earlier commit is pushed.
- No secrets in the repo: the API key was scanned for in every file and found in 0. The key
  lives only in the Windows user environment variable `MODEL_API_KEY`.

## Last verified results

| Check | Result | When |
|---|---|---|
| `npm test` locally | 53 of 53 pass | 00:45 ET |
| GitHub Actions CI on `71c1941` | Success; the log shows 53 of 53 | 00:40 ET |
| Clean clone of `ec4d43d` plus `npm test` | 47 of 47 at the time (tests were added later) | 00:12 ET |
| Demo walkthrough in Chrome (offline mode) | 19 of 19 checks pass | 00:37 ET |
| Live Muse (`muse-spark-1.3`, `muse-wonder-1.0`) | **HTTP 402 `billing_not_configured`** | 00:37 ET |

Known failures: none in tests. Known bug: a 13px horizontal scroll on a 390px phone after a War
Room replay. Root cause not found; elements inside scroll containers are suspected.

**Every test uses a scripted model or none. Nothing has ever run against live Muse.**

## State by subsystem

| Subsystem | State |
|---|---|
| Solo investigator | Done (mocked). Citations verified, one revision on rejection, patch applied to an isolated copy, A3 change request filed |
| War Room | Done (mocked). Six roles, citation-gated board, help requests, priority pre-emption and resume, Skeptic gate, fast/deep tiers |
| Governance | Done (no model). Hash-bound requests A0–A4, quorum, separation of duties, veto, expiry, kill switch (serialized), R7 conflicts, R8 restart recovery, R9 compensation. Missing: hold, revoke, release, more roles |
| Self-repair | Done (no model; Doctor mocked). Health with a minimum of 5 runs, self-case, Doctor, policy guard, canary validation (stub in tests), human approval, rollback pre-authorized |
| Sentinel | Mostly missing. A gap matrix exists; no Assurance Panel and no `sentinel:test` |
| Access | Done (no model). HMAC codes, roles, budgets, rate limit, CSRF, headers, fail-closed host |
| Offline demo | Done. `npm run demo:offline`, models labelled "not Muse", inc-001 only |

Full detail: `docs/SPEC_COMPLIANCE_REPORT.md`, `docs/IMPLEMENTATION_GAP_MATRIX.md`,
`docs/SENTINEL_GAP_MATRIX.md`.

## Release blockers

1. **Meta billing (402).** The owner must fix it at the Meta developer billing page (team
   billing settings). Do not fake or bypass it.
2. **Demo video:** not recorded. Owner.
3. **Form submission:** not done. Owner. Do not call the submission complete until the owner
   confirms the confirmation email.

## Unresolved decisions (owner)

- License: MIT was chosen by Claude. Swap it if preferred (Apache-2.0, AGPL).
- Hosting: not deployed. Access codes and the Dockerfile-free setup are ready, but there is no
  host account.
- Whether to build the small Sentinel Assurance Panel before recording (about 1–1.5 hours).
- Whether to add the V2 spec file to `docs/` (it is referenced there but absent).

## Commands

```powershell
cd C:\Users\Dell\Documents\Source\Meta\hackathon\incidentlens
git pull; git log --oneline -3; git status --short
npm test                                  # expect 53 of 53
# Billing check (new terminal so MODEL_API_KEY is loaded; prints only the HTTP status):
node -e "fetch('https://api.meta.ai/v1/responses',{method:'POST',headers:{authorization:'Bearer '+process.env.MODEL_API_KEY,'content-type':'application/json'},body:JSON.stringify({model:'muse-spark-1.3',input:'Reply OK',max_output_tokens:16})}).then(r=>console.log('HTTP',r.status))"
npm start                                 # live, http://localhost:5173 (needs billing)
npm run eval -- inc-001-pool-exhaustion   # one live scored run
# Offline demo (scripted model, labelled not Muse); reset its state first:
Remove-Item -Recurse -Force data-offline-demo, runs-offline-demo -ErrorAction SilentlyContinue
npm run demo:offline                      # http://localhost:5173
```

## Key files

- Docs: `README.md`, `CLAUDE.md` (invariants), `docs/DEMO_SCRIPT_3_MIN.md`,
  `docs/HACKATHON_SUBMISSION.md`, `docs/ARCHITECTURE.md`, `docs/GOVERNANCE.md`,
  `docs/SELF_EVOLUTION.md`, `docs/EVALUATION_PROTOCOL.md`, `docs/THREAT_MODEL.md`,
  `docs/DECISION_LOG.md`, `docs/ROADMAP.md`.
- Code: `src/governance/changes.ts`, `src/warroom/run.ts`, `src/heal/doctor.ts`, `src/llm.ts`,
  `src/server.ts`, `public/app.js`.
- Phase P backlog: GitHub issues #1–#16 (`phase-p`, `sentinel`, `priority:P0`–`P4`).

## Continue in this order after the reset

1. **Verify the state:** `git pull`, `git status` clean, `npm test` 53 of 53, CI green on HEAD.
2. **Check billing** with the node command above.
3. **If live Muse works:**
   - `npm start`, run War Room on inc-001 in the UI.
   - Check the run in `runs/` says `muse-wonder-1.0`.
   - Run `npm run eval` for real numbers.
   - Update the "no live run" lines in README.md, HACKATHON_SUBMISSION.md, IMPLEMENTATION_GAP_MATRIX.md and SPEC_COMPLIANCE_REPORT.md with the actual results, failures included.
   - Commit the recorded run only if it is redacted and useful.
4. **If still blocked:** keep the blocker documented and use Plan B (offline, said on camera).
5. **Optional, only if well before the recording:** the small Sentinel Assurance Panel and
   `npm run sentinel:test` over existing passing scenarios, reporting missing ones as missing.
   Skip it if time is tight.
6. **Before recording:**
   - Re-run `npm test`.
   - Reset the offline-demo state.
   - Walk `docs/DEMO_SCRIPT_3_MIN.md` once.
7. **Owner:**
   - Record the video.
   - Fill in the form from `docs/HACKATHON_SUBMISSION.md`.
   - Submit early.
   - Confirm the email.
8. **Feature freeze:** no new features after the recording starts. Everything else stays in the
   issues.
