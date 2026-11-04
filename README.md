# IncidentLens

An incident-investigation agent for Java/Spring Boot services on Kubernetes, built on Meta's
**Muse** models through the Meta Model API.

Given an alert, the agent investigates the incident's evidence (logs, traces, Kubernetes state,
config, source code, recent changes) through tool calls. It then submits a structured diagnosis
with a root cause, cited evidence, ruled-out hypotheses, a patch and a regression test.

What sets it apart from asking a chatbot is that **nothing the model says is taken on trust**:

- **Citation verification.** Every evidence quote is checked against the cited file and lines.
  Fabricated quotes are flagged `Not in source`, and quotes with wrong line numbers are flagged
  `Wrong lines`.
- **Patch verification.** Lines the patch removes, and the context it quotes, must exist in the
  target file.
- **Self-correction.** If verification fails, the specific failures go back to the agent, which
  gets one revision. The UI shows the rejection and the revised result.
- **Scored eval.** Each incident has a hidden answer key that the agent's tools cannot read
  (enforced and tested). `npm run eval` scores the root cause with deterministic keyword groups,
  not an LLM judge.
- **Red herrings.** Every incident contains plausible but wrong signals (GC pauses, noisy 404s,
  slow-query warnings, an unrelated config bump), so the agent cannot just report the loudest error.

## Incidents

| Incident | Real cause | Distractors |
|---|---|---|
| Checkout 5xx, p99 > 30s | Fraud HTTP call moved inside `@Transactional` → Hikari pool exhaustion | GC pauses, readiness failure, HPA scale-up |
| Pods restarting | Memory limit cut to 1024Mi while `-Xmx1024m` hard-coded → kernel OOMKill | Slow-query warnings, statement batch job |
| Customers charged twice | Retry on read timeout for a non-idempotent `POST /v1/charges` with no idempotency key | Ledger sync lag, batch-size change |
| Inventory oversold | Producer added `loyaltyTier`; consumer's own `ObjectMapper` fails on unknown properties → DLT | ERP sync slowness, retention change |
| Intermittent 503s | Readiness probe hits aggregate `/actuator/health` (incl. Redis) with 1s timeout during Redis migration | Hundreds of recommendation-widget 404s |

All incidents are synthetic, written to resemble real Spring Boot / Kubernetes failure modes.

## Run it

Requires Node 24+ (TypeScript runs directly; no build step, no dependencies).

```powershell
$env:MODEL_API_KEY = "<your key>"     # or set it once with: setx MODEL_API_KEY "<key>"
npm start                              # http://localhost:5173
npm run eval                           # score the agent on all incidents
npm run eval -- inc-003-duplicate-charges   # one incident
npm test                               # verifier, sandbox, scoring, and agent-loop tests
```

| Variable | Default | Purpose |
|---|---|---|
| `MODEL` | `muse-wonder-1.0` | Any model id from `GET /v1/models`, e.g. `muse-spark-1.3` |
| `LLM_WIRE` | `responses` | `responses` (OpenAI-style) or `messages` (Anthropic-style); both are served by the Meta Model API |
| `PORT` | `5173` | |

Every investigation is recorded under `runs/`. The UI can replay the latest recorded run, clearly
labelled with its model and time, for demos without network access.

## How it works

```
alert ──► agent loop (src/agent.ts) ──► Meta Model API (src/llm.ts)
              │   ▲
   tool calls │   │ results               list_artifacts / read_artifact / search_artifacts
              ▼   │                       sandboxed to the incident; answer key hidden (src/incidents.ts, src/tools.ts)
          submit_report
              │
              ▼
   verify citations + patch (src/verify.ts) ── fail ──► feedback to agent, one revision
              │ pass
              ▼
   score vs hidden answer key (src/score.ts) ──► SSE stream to UI (src/server.ts, public/)
```

The tests (`test/`) include positive controls. A fabricated quote must be rejected, a patch with
invented lines must mismatch, and a red-herring diagnosis must score as wrong. The agent loop is
tested end to end on both wire formats against a scripted model server that submits a fabricated
citation first.
