import type { GroundTruth } from './incidents.ts';

// Deterministic scoring against the hidden answer key: no LLM-as-judge, so the eval
// cannot be talked into a pass. Each must_mention group is a set of synonyms; the
// diagnosis is correct only when every group is matched.

export interface Score {
  correct: boolean;
  groups: { any: string[]; hit: string | null }[];
  fix_target_correct: boolean;
}

export function scoreReport(report: { summary?: string; root_cause?: string; fix?: { artifact?: string } }, gt: GroundTruth): Score {
  const text = `${report.summary ?? ''} ${report.root_cause ?? ''}`.toLowerCase();
  const groups = gt.must_mention.map((any) => ({
    any,
    hit: any.find((term) => text.includes(term.toLowerCase())) ?? null,
  }));
  const target = (report.fix?.artifact ?? '').replace(/\\/g, '/').replace(/^\.?\//, '');
  return {
    correct: groups.every((g) => g.hit !== null),
    groups,
    fix_target_correct: target === gt.fix_artifact,
  };
}
