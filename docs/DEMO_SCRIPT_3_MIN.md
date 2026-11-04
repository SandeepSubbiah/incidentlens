# Three-minute demo script

Two ways to record. Use **Plan A** only if the top bar shows `muse-wonder-1.0` / `muse-spark-1.3`
and a live run has completed. Otherwise use **Plan B** and say on camera that the model is
scripted. Never describe Plan B output as Muse output.

## Before recording

- **Plan A:** set `MODEL_API_KEY` in a new terminal, then `npm start`. Do one rehearsal run first.
- **Plan B:** delete `data-offline-demo/` and `runs-offline-demo/`, then `npm run demo:offline`.
- Browser window about 1440×900 at 100–110% zoom, on `http://localhost:5173`.
- Keep the "Checkout failing with 5xx" incident (inc-001) selected. Plan B only scripts inc-001.

## Shot list

**0:00–0:15 — The problem.** Home screen, incident list.
> "When production breaks, AI can read every log in seconds. The hard parts are trusting what it
> says, and controlling what it is allowed to change. IncidentLens does both, on Meta Muse."

**Plan B only — say this here, and keep the top bar visible:**
> "Our Meta API billing isn't active yet, so this recording uses a scripted stand-in model. It is
> not Muse, and these are not Muse's answers. Everything around the model, the verification, the
> War Room scheduler, governance and self-repair, is real code running live."

**0:15–1:00 — The War Room.** (Plan B: the lanes show `scripted-deep` / `scripted-fast`; do not call them Muse.) Select inc-001, choose **War Room · 6 agents**, click **Investigate**.
- Point at the lanes: Commander and Skeptic on the deep model, specialists on the fast model.
- In the trail, find **"Fact rejected: quote not found"**:
  > "An agent tried to post a log line that doesn't exist. It never reached the shared board."
- When the red **Live update from Support** appears, point at **"Signals paused T2 (P1) for T5 (P0)"**:
  > "Customer impact is spreading, so the team stops the bleeding first, then resumes the root
  > cause with what it missed."

**1:00–1:30 — The skeptic and the evidence.**
- Point at **"Conclusion blocked: skeptic review required"**, then the Skeptic's **stands**
  verdict: GC pauses are 18 ms, a red herring.
- In the report, click a verified fact. The source panel highlights the exact line.
  > "Every citation is checked against the file."

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
- Click **Run self-repair**. The trail shows the breach, the self-case, the rollback through a
  pre-authorized change request, and "live on the next run, no restart".
- Point at the skills table (`solo` is back to v1) and **Audit log: chain intact**.
  > "It investigates itself with the same evidence rules. It can change only its skills, never
  > its constitution or its grader, and every change is audited."

**2:45–3:00 — Close.**
- **Plan A:** "Open source, 53 automated tests, Muse Wonder for deep reasoning, Muse Spark for
  fast work. Evidence first, humans in charge."
- **Plan B:** "Open source, 53 automated tests. It is built for Muse Wonder and Muse Spark; this
  recording used a scripted model, and live Muse results are pending on billing. Evidence first,
  humans in charge."

## If something goes wrong on camera

Use **Replay recorded run**. It is labelled with its model and time.
