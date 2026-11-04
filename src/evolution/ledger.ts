import path from 'node:path';
import { auditLogAt, type AuditEntry } from '../guard/audit.ts';
import type { AgentEvent } from '../loop.ts';
import { dataDir } from '../paths.ts';

// The Evolution Ledger turns faults seen in recorded runs into improvement opportunities, each
// tied to the run record that shows it. Entries only propose: nothing here changes a skill, a
// route or a policy, and nothing reaches the governance engine without a person filing it.
// It reuses the audit log's hash chain, so entries are append-only and tampering is detectable.

export const ledger = () => auditLogAt(path.join(dataDir(), 'evolution-ledger.jsonl'));

const FAILOVER = new Set(['failover', 'circuit-open']);

function outcome(events: AgentEvent[]) {
  const report = events.find((e) => e.type === 'report');
  if (report) {
    const models = Object.entries(report.stats?.models ?? {}).map(([requested, m]: [string, any]) => ({ requested, served: m.served ?? null, calls: m.calls }));
    return { completed: true, diagnosis_correct: report.score?.correct ?? null, cost_usd: report.stats?.cost_usd ?? null, models };
  }
  const error = events.find((e) => e.type === 'error');
  return { completed: false, error: String(error?.message ?? 'no report').slice(0, 200), cost_usd: error?.usage?.cost_usd ?? null };
}

// Called once per recorded run. Seeded synthetic runs are not evidence and are skipped.
export async function recordOpportunities(incidentId: string, runFile: string, events: AgentEvent[]): Promise<AuditEntry[]> {
  const start = events.find((e) => e.type === 'start');
  if (!start || start.synthetic) return [];
  const evidence = `runs/${incidentId}/${runFile}`;
  // From the run's start event; absent on records made before provenance was recorded.
  const provenance = start.provenance ?? null;
  const added: AuditEntry[] = [];

  const failovers = events.filter((e) => e.type === 'heal' && FAILOVER.has(e.kind));
  if (failovers.length) {
    added.push(
      await ledger().append('reflex', 'opportunity.reliability', evidence, {
        category: 'reliability',
        signal: 'model-failover',
        // A chaos outage is a rehearsal, not a production fault; say which this was.
        simulated: failovers.some((e) => /\(chaos\)/.test(String(e.detail))) || !!provenance?.simulated_faults?.length,
        occurrences: failovers.length,
        provenance,
        first: String(failovers[0].detail).slice(0, 200),
        circuit_opened: failovers.some((e) => e.kind === 'circuit-open'),
        outcome: outcome(events),
        proposal: 'Compare diagnosis quality and cost of fallback-model runs with primary-model runs before relying on failover for this incident type.',
        regression_test: 'test/reflexes.test.ts: chaos outage triggers failover without touching the network for the failed model',
        status: 'open',
      }),
    );
  }

  const quarantined = events.filter((e) => e.type === 'quarantine');
  if (quarantined.length) {
    added.push(
      await ledger().append('guard', 'opportunity.security', evidence, {
        category: 'security',
        signal: 'prompt-injection-quarantined',
        // An injection inside an authored test incident was planted on purpose. Unknown stays null.
        simulated: provenance ? provenance.incident !== 'imported' : null,
        occurrences: quarantined.length,
        provenance,
        lines: quarantined.slice(0, 5).map((q) => `${q.artifact}:${q.line}`),
        outcome: outcome(events),
        proposal: 'Add these lines to the injection regression corpus and confirm the diagnosis ignored them.',
        regression_test: 'test/guard.test.ts: injection quarantine',
        status: 'open',
      }),
    );
  }
  return added;
}
