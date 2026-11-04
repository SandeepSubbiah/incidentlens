# IncidentLens — notes for coding agents

## Commands
- `npm test` — all tests (Node test runner over `test/**/*.test.ts`). No network, no API key.
- `npm run demo:offline` — full app on a scripted model (inc-001 only), labelled as not Muse.
- `npm start` — live server; needs `MODEL_API_KEY` and working Meta billing.
- `npm run eval [-- --warroom] [incident ids]` — scored runs against hidden answer keys.
- Node 24 runs the TypeScript directly (type stripping). No enums, namespaces or constructor
  parameter properties, and `import type` for type-only imports.

## Invariants (do not break)
1. Agents never read `incident.json` or `ground-truth.json` (`src/incidents.ts` HIDDEN). Tests
   enforce it. Validation runs for self-repair score against answer keys the Doctor cannot read.
2. Evidence enters the War Room board only through `post_fact`, which verifies the quote.
3. Every change to skills or remediation goes through `src/governance/changes.ts`. Approval binds
   to the change hash; the requester cannot approve; veto, expiry and the kill switch win.
4. `core/constitution.md` is pinned by SHA-256 in `src/guard/constitution.ts`. Changing it means
   updating the pin in a reviewed commit. Self-repair can change only role and runbook skills.
5. Test runs must use temp `INCIDENTLENS_DATA_DIR` and `INCIDENTLENS_RUNS_DIR`, or scripted output
   leaks into real run history and case memory.
6. Never present scripted or synthetic output as Muse output. Synthetic run records carry
   `synthetic: true`; offline-demo models are named `scripted-...`.
7. Never write `MODEL_API_KEY` or `ACCESS_SECRET` to a file or log.

## Map
See the module table in README.md. Decisions and rejected alternatives: docs/DECISION_LOG.md.
Capability status: docs/IMPLEMENTATION_GAP_MATRIX.md.
