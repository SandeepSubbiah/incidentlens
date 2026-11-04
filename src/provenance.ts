import { activeFaults } from './chaos.ts';
import type { IncidentMeta } from './incidents.ts';
import { modelEndpoint } from './llm.ts';

// Where the data behind a record came from, so nothing simulated can be mistaken for real:
// - incident: 'synthetic' means an authored test case, not a production incident.
// - inference: 'live' means requests went to the Meta Model API; 'scripted' means any other
//   endpoint (the offline demo and tests); 'none' means no model was involved.
// - simulated_faults: faults injected on purpose that were active when the record was made.
// A record without these fields predates them, and is shown as "not recorded", never as real.

export type IncidentSource = 'synthetic' | 'imported' | 'self-case' | 'unstated';
export type InferenceSource = 'live' | 'scripted' | 'none';

export interface Provenance {
  incident: IncidentSource;
  inference: InferenceSource;
  endpoint?: string;
  simulated_faults?: string[];
  synthetic_runs?: number;
}

export function incidentSource(meta: Pick<IncidentMeta, 'provenance'> | undefined): IncidentSource {
  const p = meta?.provenance;
  return p === 'synthetic' || p === 'imported' ? p : 'unstated';
}

export function provenanceNow(incident: IncidentSource, inference: InferenceSource = modelEndpoint().live ? 'live' : 'scripted'): Provenance {
  const faults = activeFaults().map((f) => `${f.kind} ${f.model}`);
  return {
    incident,
    inference,
    ...(inference === 'none' ? {} : { endpoint: modelEndpoint().host }),
    ...(faults.length ? { simulated_faults: faults } : {}),
  };
}
