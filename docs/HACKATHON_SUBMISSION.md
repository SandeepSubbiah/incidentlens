# Submission pack — Meta Global AI Developer Hackathon 2026

Ready-to-paste answers. The submission form sits behind a login, so the field names below are
generic. Pick the version that fits each field's length.

- **Project:** IncidentLens
- **Track:** Indie Developer
- **Repository (open source, MIT):** https://github.com/SandeepSubbiah/incidentlens
- **Demo video:** _add link_

## Tagline
Evidence-first incident investigation with governed self-repair, built on Meta Muse.

## One sentence
A team of Muse agents investigates production incidents, refuses any quoted evidence it cannot
find in the source, shows its fix applies to an isolated copy, and cannot change anything (including itself) without
hash-bound human approval.

## Short description (about 100 words)
IncidentLens investigates incidents in Java/Spring Boot services on Kubernetes. A Muse Wonder
commander leads Muse Spark specialists through logs, traces, config and code, with a skeptic
that must try to disprove the leading theory before anyone concludes. Every quoted fact is checked
against the source before other agents can see it, and every fix is applied to an isolated copy
and filed as a risk-classed change request that needs distinct human approvers. IncidentLens
also watches its own quality: when it degrades, it investigates itself, proposes a rollback or a
minimal skill change, validates it, and waits for approval.

## What problem does it solve?
AI can read every log during an outage, but on-call engineers can't act on an answer they can't
check, and they can't let an agent change production on its own judgement. IncidentLens makes
the AI's work checkable (citations located in the source, patches shown to apply to an isolated
copy) and its authority
explicit (approvals bound to the exact change, veto, expiry, kill switch).

## How we used Meta's models
- `muse-wonder-1.0` for deep reasoning: commander, skeptic, fixer, solo investigator and the
  self-repair doctor.
- `muse-spark-1.3` for fast evidence gathering: the signals, platform and code specialists.
  Specialists escalate to Wonder after repeated rejected facts.
- Tool calling over the Responses API (the Messages API also supported), with reasoning effort
  per tier. It drops settings the endpoint rejects, honours `Retry-After`, and fails over between
  tiers when a model is down. It never retries billing errors.

## What's novel
1. **A citation-gated shared board.** Agents cannot spread each other's hallucinations, because
   evidence enters only through a tool that verifies the quote.
2. **Incident-command scheduling.** Priority pre-emption at turn boundaries, so a P0 live update
   pauses root-cause work for mitigation, then resumes it with what changed.
3. **A governance gate the AI cannot talk past.** Approvals are bound to a SHA-256 of the exact
   change; the requester can't approve; veto and expiry win; A3 needs two people; A4 is
   prohibited; everything goes in a hash-chained audit log.
4. **Self-repair that cannot grade itself.** IncidentLens investigates its own regressions, can
   change only its skills, validates against answer keys it cannot read, and waits for approval.
   Its constitution is pinned by hash in code.

## What is real and what is simulated
- Implemented and covered by 53 automated tests in CI: verification, the War Room scheduler,
  governance, self-repair, retrieval, access control and the guards.
- **Live Muse runs: not yet recorded.** The Meta Model API returns `402 billing_not_configured`
  for this account. _Update this line if billing is fixed and a live run is recorded._
- A verified citation proves the quoted text exists at the cited lines. It does not prove the conclusion drawn from it. Causal conclusions are
  judged by the Skeptic agent, by scoring against hidden answer keys in evaluation, and by the
  humans who approve the fix. Claim-level verification is planned (issue #6).
- Remediation execution is simulated by design: patches are applied to an isolated copy, never
  to a real system.
- The offline demo uses a scripted model labelled "not Muse". The self-repair demo uses seeded
  synthetic run records, labelled as synthetic.

## Built with
Node.js 24 (TypeScript, no runtime dependencies), Meta Model API, vanilla HTML/CSS/JS,
GitHub Actions.

## Try it
```
git clone https://github.com/SandeepSubbiah/incidentlens && cd incidentlens
npm test               # 53 tests, no key needed
npm run demo:offline   # full UI with a scripted model, http://localhost:5173
npm start              # live, with MODEL_API_KEY
```
