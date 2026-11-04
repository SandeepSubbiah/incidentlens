import { ARTIFACT_TOOLS, SUBMIT_TOOL, type ToolDef } from '../tools.ts';
import type { Role } from './board.ts';

const roleEnum = { type: 'string', enum: ['commander', 'signals', 'platform', 'code', 'skeptic', 'fixer'] };
const priority = { type: 'integer', minimum: 0, maximum: 3, description: '0 = customer impact ongoing / mitigation, 1 = root cause, 2 = supporting, 3 = nice to have' };
const factIds = { type: 'array', items: { type: 'string' }, description: 'Verified fact ids such as F3.' };
const submitProps = (SUBMIT_TOOL.parameters as any).properties;

const def = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef => ({
  name,
  description,
  parameters: { type: 'object', properties, required, additionalProperties: false },
});

export const POST_FACT = def(
  'post_fact',
  'Post a finding to the shared board. The quote is checked against the artifact; a quote that does not exist is rejected. This is the only way evidence enters the board.',
  {
    claim: { type: 'string', description: 'One-line finding in your own words.' },
    artifact: { type: 'string' },
    start_line: { type: 'integer' },
    end_line: { type: 'integer' },
    quote: { type: 'string', description: 'Verbatim text from the artifact, without the "N| " prefix.' },
  },
  ['claim', 'artifact', 'start_line', 'end_line', 'quote'],
);

export const PROPOSE_HYPOTHESIS = def('propose_hypothesis', 'Add a hypothesis to the board, linked to the verified facts that support it.', { statement: { type: 'string' }, fact_ids: factIds }, ['statement', 'fact_ids']);

export const ASK_AGENT = def(
  'ask_agent',
  'Ask another agent for help. This creates a task for them; their answer arrives later as a board message. Keep working meanwhile.',
  { to: roleEnum, question: { type: 'string' }, priority },
  ['to', 'question'],
);

export const COMPLETE_TASK = def('complete_task', 'Finish your current task with a short result: findings with fact ids, what you ruled out, open questions.', { result: { type: 'string' } }, ['result']);

export const CREATE_TASK = def(
  'create_task',
  'Assign a task to an agent. Several tasks can run in parallel; more urgent tasks pre-empt less urgent ones.',
  {
    role: roleEnum,
    title: { type: 'string' },
    detail: { type: 'string', description: 'The precise question to answer and where to look.' },
    priority,
    kind: { type: 'string', enum: ['investigate', 'mitigate', 'review', 'fix'], description: 'Use mitigate for stop-the-bleeding work (fixer or platform).' },
  },
  ['role', 'title', 'detail', 'priority'],
);

export const SET_PRIORITY = def('set_priority', 'Change a task priority when the situation changes.', { task_id: { type: 'string' }, priority, reason: { type: 'string' } }, ['task_id', 'priority', 'reason']);

export const CANCEL_TASK = def('cancel_task', 'Cancel a queued or paused task that is no longer useful.', { task_id: { type: 'string' }, reason: { type: 'string' } }, ['task_id', 'reason']);

export const UPDATE_HYPOTHESIS = def(
  'update_hypothesis',
  'Mark a hypothesis supported, refuted or open, optionally adding supporting or contradicting fact ids.',
  { id: { type: 'string' }, status: { type: 'string', enum: ['open', 'supported', 'refuted'] }, support: factIds, against: factIds, reason: { type: 'string' } },
  ['id', 'status', 'reason'],
);

export const CONCLUDE = def(
  'conclude',
  'Conclude the investigation on one hypothesis. Requires at least two verified supporting facts and a skeptic review that did not refute it.',
  {
    hypothesis_id: { type: 'string' },
    summary: submitProps.summary,
    root_cause: submitProps.root_cause,
    category: submitProps.category,
    confidence: submitProps.confidence,
    timeline: submitProps.timeline,
    next_steps: submitProps.next_steps,
    ruled_out: submitProps.ruled_out,
  },
  ['hypothesis_id', 'summary', 'root_cause', 'category', 'confidence', 'next_steps'],
);

export const CHALLENGE = def(
  'challenge_hypothesis',
  'Record your review of a hypothesis. Refuting requires at least one verified fact id.',
  { hypothesis_id: { type: 'string' }, verdict: { type: 'string', enum: ['stands', 'weakened', 'refuted'] }, reason: { type: 'string' }, fact_ids: factIds },
  ['hypothesis_id', 'verdict', 'reason', 'fact_ids'],
);

export const SUBMIT_MITIGATION = def(
  'submit_mitigation',
  'Record immediate, reversible mitigation steps that stop customer impact.',
  { steps: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' } },
  ['steps', 'rationale'],
);

export const SUBMIT_FIX = def(
  'submit_fix',
  'Submit the permanent fix: a unified diff against an artifact you have read (removed and context lines must match it exactly), a regression test, and mitigation steps.',
  {
    mitigation: { type: 'array', items: { type: 'string' } },
    artifact: { type: 'string' },
    explanation: { type: 'string' },
    patch: { type: 'string' },
    regression_test: submitProps.regression_test,
  },
  ['mitigation', 'artifact', 'explanation', 'patch', 'regression_test'],
);

const BY_ROLE: Record<Role, ToolDef[]> = {
  commander: [POST_FACT, PROPOSE_HYPOTHESIS, UPDATE_HYPOTHESIS, CREATE_TASK, SET_PRIORITY, CANCEL_TASK, ASK_AGENT, CONCLUDE, COMPLETE_TASK],
  signals: [POST_FACT, PROPOSE_HYPOTHESIS, ASK_AGENT, COMPLETE_TASK],
  platform: [POST_FACT, PROPOSE_HYPOTHESIS, ASK_AGENT, SUBMIT_MITIGATION, COMPLETE_TASK],
  code: [POST_FACT, PROPOSE_HYPOTHESIS, ASK_AGENT, COMPLETE_TASK],
  skeptic: [POST_FACT, CHALLENGE, ASK_AGENT, COMPLETE_TASK],
  fixer: [POST_FACT, SUBMIT_MITIGATION, SUBMIT_FIX, ASK_AGENT, COMPLETE_TASK],
};

export function toolsFor(role: Role): ToolDef[] {
  return [...ARTIFACT_TOOLS, ...BY_ROLE[role]];
}
