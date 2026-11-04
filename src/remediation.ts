import { propose } from './governance/changes.ts';
import type { IncidentMeta } from './incidents.ts';
import { incidentSource, provenanceNow } from './provenance.ts';
import { sandboxApply, type SandboxResult } from './sandbox.ts';

// Turns a report's proposed fix into something a human can govern: the patch is first applied
// to an isolated copy, then filed as an A3 change request (production code change: two distinct
// approvers, execution simulated only).

export async function gateRemediation(caseId: string, meta: IncidentMeta, report: any, mode: string, propose_change: boolean) {
  const fix = report.fix ?? { artifact: '', patch: '' };
  const sandbox: SandboxResult = await sandboxApply(caseId, fix);
  if (!propose_change) return { sandbox, change_request: null };
  const cr = await propose({
    kind: 'remediation',
    title: `Apply fix to ${fix.artifact} (${meta.service})`,
    requester: `incidentlens:${mode}`,
    risk: 'A3',
    target: `${meta.service}:${fix.artifact}`,
    payload: { incident: caseId, artifact: fix.artifact, patch: fix.patch, explanation: fix.explanation ?? '' },
    evidence: (report.evidence ?? []).map((e: any) => `${e.artifact}:${e.start_line}`),
    provenance: provenanceNow(incidentSource(meta)),
  });
  const { payload, decisions, ...summary } = cr;
  return { sandbox, change_request: summary };
}
