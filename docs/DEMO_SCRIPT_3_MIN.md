# Three-minute demo script

Two ways to record. **Plan A (live Muse)** is the default: live calls were verified on
2026-11-04 from 10:13 ET. Use it when the top bar shows `muse-wonder-1.0` / `muse-spark-1.3`
and your rehearsal run below completed. Use **Plan B** only if live calls fail on the day, and
say on camera that the model is scripted. Never describe Plan B output as Muse output.

Live runs vary. Narrate what your run shows, not what an earlier run showed. If a beat below does
not appear in your run, skip it rather than describe it.

## Before recording

**Plan A:**
1. Open a **new** PowerShell window, so it picks up `MODEL_API_KEY`, then run:
   ```powershell
   cd incidentlens                 # your clone
   git checkout main
   git pull --ff-only
   npm test                        # expect 103 of 103
   $env:MODEL_API_KEY = [Environment]::GetEnvironmentVariable("MODEL_API_KEY", "User")
   npm start
   ```
   The terminal must print `(deep muse-wonder-1.0, fast muse-spark-1.3, responses API, open access)`.
   If it says `MODEL_API_KEY NOT SET`, the window is too old; open another.
2. **Rehearsal run (required).** Open `http://localhost:5173`, select inc-001, choose
   **War Room · 6 agents**, click **Investigate**. It takes about 3–4 minutes and costs about
   $0.70–0.85. This run becomes the one **Replay recorded run** plays back, and its change request
   is the one the Go / No-Go card shows. So:
   - Do **not** click Approve or Veto during the rehearsal.
   - Record within **2 hours** of it. A3 change requests expire after 120 minutes, and Approve
     would then be refused with **R3: approval window expired**. If that happens, run another
     rehearsal.
3. While it runs, note what your trail shows, so you narrate only what happened:
   - Is there a **Fact rejected** line? Note the reason it gives.
   - Is there a **paused … for …** line after the live update?
   - What is the Skeptic's verdict (**Review of H1: stands** or another)?
4. Browser window about 1440×900 at 100–110% zoom. Keep inc-001 selected.

**Plan B:** delete `data-offline-demo/` and `runs-offline-demo/`, then `npm run demo:offline`.
Plan B only scripts inc-001.

## Shot list

**0:00–0:15 — The problem.** Home screen, incident list.
> "When production breaks, AI can read every log in seconds. The hard parts are trusting what it
> says, and controlling what it is allowed to change. IncidentLens does both."
- **Plan A** adds: "…and every agent you'll see is running on Meta Muse."
- **Plan B** does not mention Muse as running here; go straight to the disclaimer below.

**Plan B only — say this here, and keep the top bar visible:**
> "Live Meta API calls aren't available for this recording, so it uses a scripted stand-in model.
> It is not Muse, and these are not Muse's answers. Everything around the model, the
> verification, the War Room scheduler, governance and self-repair, is real code running live."

**0:15–1:00 — The War Room.** Select inc-001, choose **War Room · 6 agents**.
- **Plan A:** click **Replay recorded run**. The banner reads "Replay of a recorded run
  (muse-wonder-1.0) from …". Say:
  > "This is a live Muse investigation we ran a few minutes ago, replayed at speed. The real run
  > took about three and a half minutes and cost under a dollar."

  Alternative: click **Investigate** and record the whole live run, then shorten the wait in
  editing with an on-screen caption such as "live run, shortened".
- **Plan B:** click **Investigate**. The lanes show `scripted-deep` / `scripted-fast`; do not call
  them Muse.
- Point at the lanes: Commander and Skeptic on the deep model, specialists on the fast model.
- **If** the trail has a **Fact rejected: quote not found** line, point at it and say what it
  says. For example, in the 10:17 rehearsal the Code agent quoted the deploy diff without its
  minus signs:
  > "An agent quoted the diff, but not exactly. Close isn't good enough: the quote doesn't match
  > the file, so it never reached the shared board."

  In Plan B the scripted line is a log line that doesn't exist:
  > "An agent tried to post a log line that doesn't exist. It never reached the shared board."
- When the red **Scripted update from Support** appears, point at the **paused … for … (P0)**
  line. The update is part of the synthetic incident's script, and the screen says so:
  > "In this test incident, a scripted message says customer impact is spreading, so the team
  > stops the bleeding first, then resumes the root cause with what it missed."

**1:00–1:30 — The skeptic and the evidence.**
- Point at the Skeptic's verdict, **Review of H1: stands**. Live runs usually show the Skeptic
  searching for counter-evidence first. **Conclusion blocked: skeptic review required** appears
  only if the Commander tried to conclude early. In Plan B it does, and the Skeptic's verdict is
  that GC pauses are 18 ms, a red herring.
- In the report, click a verified fact. The source panel highlights the exact line.
  > "Every citation is checked against the file. That proves the quote is real, not that the
  > conclusion is right: the Skeptic challenges the reasoning, and a human approves the fix."

**1:30–2:00 — Go / No-Go.** Scroll to **Proposed fix**.
- Point at **Lines found in source** and **Applied to isolated copy**:
  > "The patch is really applied, to a copy. Production is never touched."
- In the **Go / No-Go** card, type a reason and click **Approve**. It shows "1 of 2 required
  approvals".
- Click **Approve** again. The refusal reads **"R5: … a second, different approver is
  required"**.
- Click **Veto**: **"R2: vetoed; no later approval can revive it"**.
  > "The AI only proposes. Approval is bound to the exact change, and one person can't push a
  > production change alone."

**2:00–2:45 — It repairs itself, within limits.** Open **Health and self-repair**.
- Click **Seed a regression (synthetic runs)**. Say that the run records are synthetic, and point
  at the "5 synthetic (seeded)" label. The indicators turn **breached**.
- Click **Run self-repair**.
  - **Plan A:** the Doctor is Muse Wonder. In the rehearsal it took 18 seconds. The trail shows
    the breach, the self-case, its **Diagnosis: …** line (it found the bad skill edit) and the
    rollback through a pre-authorized change request.
    > "The Doctor is Muse investigating IncidentLens itself, with the same evidence rules."
  - **Plan B:** the deterministic rollback rule acts, because there is no model.
- Point at the skills table (`solo` is back to v1) and **Audit log: chain intact**.
  > "It can change only its skills, never its constitution or its grader, and every change is
  > audited."

**2:45–3:00 — Close.**
- **Plan A:** "Open source, 103 automated tests. On live Muse, it diagnosed all five of our test
  incidents correctly in solo mode, with every cited quote verified. Evidence first, humans in
  charge." Only say this if the numbers in `docs/EVALUATION_PROTOCOL.md` still say so.
- **Plan B:** "Open source, 103 automated tests. It is built for Muse Wonder and Muse Spark; this
  recording used a scripted model. Evidence first, humans in charge."

## Optional: continuity beat (Plan A, about 20 seconds)

Use it only if you can shorten the live run in editing. It takes about 90 seconds live. A good
place is in place of part of the self-repair segment.

1. On the Health page, click **Simulate deep-model outage**.
   > "We cut off Muse Wonder on purpose."
2. Open inc-001, choose **Solo agent**, click **Investigate**. Cut to the result.
   - Point at the trail's **Reflex · Failover** and **Circuit opened** lines.
   - Point at **Answered by muse-spark-1.3** in the report.
   > "Wonder is down, so the work moves to Spark, and the report names the model that actually
   > answered. The outage is simulated; Spark's answer is real."
3. Back on the Health page, point at the **Evolution ledger** entry marked **simulated fault**.
   > "Every fault becomes a proposal linked to its evidence. It changes nothing on its own."
4. Click **Clear faults**. Wait at least 60 seconds before anything that uses Wonder, including
   **Run self-repair**. The circuit stays open until then and Wonder work would go to Spark.

Do not say it is zero-downtime or that streaming resumes: neither is built.

## After recording (Plan A)

Seeding a regression in live mode writes five synthetic run records into `runs/` and a bad
`solo` skill version into `data/`. The Doctor rolls the skill back during the demo. Then:

1. On the Health page, confirm `solo` is back to v1.
2. Delete the synthetic run records so they stop counting in the health indicators:
   ```powershell
   Remove-Item runs\*\*-synthetic.json
   ```

## If something goes wrong on camera

Use **Replay recorded run**. It is labelled with its model and time.
