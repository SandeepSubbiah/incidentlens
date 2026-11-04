import { listArtifacts, readArtifact } from './incidents.ts';

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const MAX_READ_LINES = 300;
const MAX_SEARCH_HITS = 60;

export const SUBMIT = 'submit_report';

export const TOOLS: ToolDef[] = [
  {
    name: 'list_artifacts',
    description: 'List every evidence file available for this incident (logs, traces, Kubernetes state, config, source code, recent changes) with line counts.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_artifact',
    description: `Read an evidence file. Output lines are prefixed with "<line number>| ". At most ${MAX_READ_LINES} lines per call; use start_line/end_line for large files.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Artifact path exactly as returned by list_artifacts.' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_artifacts',
    description: `Case-insensitive regular-expression search across all artifacts (or one, via path). Returns up to ${MAX_SEARCH_HITS} matching lines as "path:line| text".`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression, e.g. "timed out|timeout".' },
        path: { type: 'string', description: 'Optional: restrict to one artifact.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: SUBMIT,
    description: 'Submit the final investigation report. Call exactly once, after you have read the evidence. Every evidence quote must be copied verbatim from read_artifact output (without the line-number prefix).',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One or two sentences an on-call engineer can act on.' },
        root_cause: { type: 'string', description: 'The causal chain from trigger to customer impact.' },
        category: { type: 'string', enum: ['code-change', 'configuration', 'capacity', 'dependency', 'data-contract', 'infrastructure', 'other'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        timeline: {
          type: 'array',
          items: {
            type: 'object',
            properties: { time: { type: 'string' }, event: { type: 'string' } },
            required: ['time', 'event'],
          },
        },
        evidence: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            properties: {
              artifact: { type: 'string' },
              start_line: { type: 'integer' },
              end_line: { type: 'integer' },
              quote: { type: 'string', description: 'Exact text from the artifact.' },
              supports: { type: 'string', description: 'What this evidence proves.' },
            },
            required: ['artifact', 'start_line', 'end_line', 'quote', 'supports'],
          },
        },
        ruled_out: {
          type: 'array',
          description: 'Plausible hypotheses or noisy signals you rejected, and why.',
          items: {
            type: 'object',
            properties: { hypothesis: { type: 'string' }, reason: { type: 'string' } },
            required: ['hypothesis', 'reason'],
          },
        },
        fix: {
          type: 'object',
          properties: {
            artifact: { type: 'string', description: 'Path of the artifact the patch changes.' },
            explanation: { type: 'string' },
            patch: { type: 'string', description: 'Unified diff against that artifact. Lines starting with "-" must exist in it verbatim.' },
          },
          required: ['artifact', 'explanation', 'patch'],
        },
        regression_test: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            language: { type: 'string' },
            code: { type: 'string' },
          },
          required: ['name', 'language', 'code'],
        },
        next_steps: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'root_cause', 'category', 'confidence', 'evidence', 'ruled_out', 'fix', 'regression_test', 'next_steps'],
    },
  },
];

export interface ToolResult {
  output: string;
  // One-line description for the live investigation timeline.
  label: string;
}

export async function runTool(incidentId: string, name: string, args: any): Promise<ToolResult> {
  switch (name) {
    case 'list_artifacts': {
      const arts = await listArtifacts(incidentId);
      return {
        output: arts.map((a) => `${a.path} (${a.lines} lines)`).join('\n'),
        label: `Listed ${arts.length} artifacts`,
      };
    }
    case 'read_artifact': {
      const lines = await readArtifact(incidentId, args.path);
      const start = Math.max(1, Number(args.start_line) || 1);
      const end = Math.min(lines.length, Number(args.end_line) || lines.length, start + MAX_READ_LINES - 1);
      const body = lines.slice(start - 1, end).map((l, i) => `${start + i}| ${l}`).join('\n');
      const more = end < lines.length ? `\n[... ${lines.length - end} more lines; call again with start_line=${end + 1}]` : '';
      return { output: body + more, label: `Read ${args.path} L${start}-${end}` };
    }
    case 'search_artifacts': {
      let re: RegExp;
      try {
        re = new RegExp(args.pattern, 'i');
      } catch {
        re = new RegExp(String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      }
      const targets = args.path ? [args.path] : (await listArtifacts(incidentId)).map((a) => a.path);
      const hits: string[] = [];
      for (const p of targets) {
        const lines = await readArtifact(incidentId, p);
        lines.forEach((l, i) => {
          if (hits.length < MAX_SEARCH_HITS && re.test(l)) hits.push(`${p}:${i + 1}| ${l}`);
        });
      }
      return {
        output: hits.length ? hits.join('\n') : 'no matches',
        label: `Searched /${args.pattern}/ — ${hits.length} hit${hits.length === 1 ? '' : 's'}`,
      };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
