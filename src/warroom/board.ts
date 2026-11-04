import { verifyEvidence } from '../verify.ts';

// Shared situational awareness for the War Room. Facts enter only through post_fact, which
// verifies the quote against the artifact first, so one agent's hallucination cannot become
// another agent's premise.

export type Role = 'commander' | 'signals' | 'platform' | 'code' | 'skeptic' | 'fixer';
export const ROLES: Role[] = ['commander', 'signals', 'platform', 'code', 'skeptic', 'fixer'];
export type Priority = 0 | 1 | 2 | 3;
export type TaskKind = 'plan' | 'replan' | 'update' | 'investigate' | 'help' | 'review' | 'mitigate' | 'fix';

export interface Fact {
  id: string;
  by: Role;
  claim: string;
  artifact: string;
  start_line: number;
  end_line: number;
  quote: string;
  corrected_from?: number;
}

export interface Hypothesis {
  id: string;
  by: Role;
  statement: string;
  status: 'open' | 'supported' | 'refuted';
  support: string[];
  against: string[];
  review?: { verdict: 'stands' | 'weakened' | 'refuted'; reason: string; fact_ids: string[] };
}

export interface Task {
  id: string;
  role: Role;
  kind: TaskKind;
  title: string;
  detail: string;
  priority: Priority;
  status: 'queued' | 'running' | 'parked' | 'done' | 'failed' | 'cancelled';
  createdBy: string;
  result?: string;
  hypothesis?: string;
  steps: number;
}

export interface Message {
  id: string;
  from: string;
  to: Role | 'all';
  kind: 'help' | 'answer' | 'challenge' | 'update' | 'info';
  text: string;
  task?: string;
}

export interface Conclusion {
  hypothesis: string;
  summary: string;
  root_cause: string;
  category: string;
  confidence: number;
  timeline: { time: string; event: string }[];
  next_steps: string[];
  ruled_out: { hypothesis: string; reason: string }[];
  forced: boolean;
}

export interface Fix {
  artifact: string;
  explanation: string;
  patch: string;
  regression_test: { name: string; language: string; code: string };
  mitigation: string[];
}

type Emit = (e: { type: string; [k: string]: any }) => void;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export class Board {
  version = 0;
  facts: Fact[] = [];
  hypotheses: Hypothesis[] = [];
  tasks: Task[] = [];
  messages: Message[] = [];
  mitigations: { by: Role; steps: string[]; rationale: string }[] = [];
  rejectedFacts = 0;
  conclusion: Conclusion | null = null;
  fix: Fix | null = null;
  forced = false;
  private readonly caseId: string;
  private readonly emit: Emit;
  private changes: { v: number; text: string; to: Role | 'all' }[] = [];
  private seq = { F: 0, H: 0, T: 0, M: 0 };

  constructor(caseId: string, emit: Emit) {
    this.caseId = caseId;
    this.emit = emit;
  }

  private bump(text: string, to: Role | 'all' = 'all') {
    this.version++;
    this.changes.push({ v: this.version, text, to });
  }

  task(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  hypothesis(id: string): Hypothesis | undefined {
    return this.hypotheses.find((h) => h.id === id);
  }

  addTask(t: { role: Role; kind: TaskKind; title: string; detail: string; priority: Priority; createdBy: string; hypothesis?: string }): Task {
    const task: Task = { ...t, id: `T${++this.seq.T}`, status: 'queued', steps: 0 };
    this.tasks.push(task);
    this.bump(`${task.id} created for ${task.role} (P${task.priority}, by ${task.createdBy}): ${task.title}`);
    this.emit({ type: 'task', task: { ...task } });
    return task;
  }

  setStatus(task: Task, status: Task['status'], result?: string) {
    task.status = status;
    if (result !== undefined) task.result = result;
    if (status === 'done' || status === 'failed') this.bump(`${task.id} (${task.role}) ${status}${result ? `: ${clip(result, 240)}` : ''}`);
    this.emit({ type: 'task', task: { ...task } });
  }

  setPriority(task: Task, priority: Priority, by: string, reason: string) {
    const from = task.priority;
    task.priority = priority;
    this.bump(`${task.id} priority P${from} -> P${priority} by ${by}: ${reason}`);
    this.emit({ type: 'task', task: { ...task }, reprioritized: { from, to: priority, by, reason } });
  }

  async postFact(by: Role, f: { claim: string; artifact: string; start_line: number; end_line: number; quote: string }): Promise<{ ok: true; fact: Fact; duplicate?: boolean } | { ok: false; reason: string }> {
    const check = await verifyEvidence(this.caseId, f);
    if (check.status === 'not_found' || check.status === 'missing_artifact') {
      this.rejectedFacts++;
      const reason = check.status === 'missing_artifact' ? `artifact ${f.artifact} does not exist` : `quote not found in ${f.artifact}`;
      // Kept whole (up to 4,000 chars, flagged beyond that) so the rejection can be audited later.
      const quote = String(f.quote);
      this.emit({ type: 'fact_rejected', by, artifact: f.artifact, quote: clip(quote, 4000), ...(quote.length > 4000 ? { quote_truncated: true } : {}), reason });
      return { ok: false, reason };
    }
    // A real quote with wrong line numbers is still real evidence: keep it, at the right lines.
    let start = Number(f.start_line);
    let end = Number(f.end_line);
    let corrected_from: number | undefined;
    if (check.status === 'misplaced' && check.found_line) {
      corrected_from = start;
      end = check.found_line + Math.max(0, end - start);
      start = check.found_line;
    }
    const dup = this.facts.find((x) => x.artifact === f.artifact && x.start_line === start && x.end_line === end);
    if (dup) return { ok: true, fact: dup, duplicate: true };
    const fact: Fact = { id: `F${++this.seq.F}`, by, claim: String(f.claim), artifact: f.artifact, start_line: start, end_line: end, quote: String(f.quote), corrected_from };
    this.facts.push(fact);
    this.bump(`${fact.id} (${by}) ${clip(fact.claim, 160)} [${fact.artifact}:${start}]`);
    this.emit({ type: 'fact', fact: { ...fact } });
    return { ok: true, fact };
  }

  missingFacts(ids: string[]): string[] {
    return ids.filter((id) => !this.facts.some((f) => f.id === id));
  }

  proposeHypothesis(by: Role, statement: string, factIds: string[]): Hypothesis {
    const h: Hypothesis = { id: `H${++this.seq.H}`, by, statement, status: 'open', support: [...new Set(factIds)], against: [] };
    this.hypotheses.push(h);
    this.bump(`${h.id} proposed by ${by}: ${clip(statement, 200)} (support ${h.support.join(', ') || 'none'})`);
    this.emit({ type: 'hypothesis', hypothesis: { ...h } });
    return h;
  }

  updateHypothesis(h: Hypothesis, by: string, change: { status?: Hypothesis['status']; support?: string[]; against?: string[]; reason?: string }) {
    if (change.status) h.status = change.status;
    if (change.support) h.support = [...new Set([...h.support, ...change.support])];
    if (change.against) h.against = [...new Set([...h.against, ...change.against])];
    this.bump(`${h.id} is ${h.status} (by ${by})${change.reason ? `: ${clip(change.reason, 200)}` : ''}`);
    this.emit({ type: 'hypothesis', hypothesis: { ...h } });
  }

  review(h: Hypothesis, by: Role, verdict: 'stands' | 'weakened' | 'refuted', reason: string, factIds: string[]) {
    h.review = { verdict, reason, fact_ids: factIds };
    if (verdict === 'refuted') {
      h.status = 'refuted';
      h.against = [...new Set([...h.against, ...factIds])];
    }
    this.bump(`${h.id} reviewed by ${by}: ${verdict} — ${clip(reason, 220)}`);
    this.emit({ type: 'hypothesis', hypothesis: { ...h } });
  }

  message(from: string, to: Role | 'all', kind: Message['kind'], text: string, task?: string): Message {
    const m: Message = { id: `M${++this.seq.M}`, from, to, kind, text, task };
    this.messages.push(m);
    this.bump(`message ${from} -> ${to} (${kind}): ${clip(text, 300)}`, to);
    this.emit({ type: 'message', message: { ...m } });
    return m;
  }

  addMitigation(by: Role, steps: string[], rationale: string) {
    this.mitigations.push({ by, steps, rationale });
    this.bump(`mitigation proposed by ${by}: ${clip(steps.join('; '), 240)}`);
    this.emit({ type: 'mitigation', by, steps, rationale });
  }

  // What an agent needs to know since it last looked: everything public, plus its own messages.
  deltaFor(role: Role, since: number): string {
    const lines = this.changes.filter((c) => c.v > since && (c.to === 'all' || c.to === role)).map((c) => `- ${c.text}`);
    if (!lines.length) return '';
    const shown = lines.length > 30 ? [`- (${lines.length - 30} earlier changes omitted)`, ...lines.slice(-30)] : lines;
    return `Board changes since your last turn (v${since} -> v${this.version}):\n${shown.join('\n')}`;
  }

  situation(): string {
    const facts = this.facts.slice(-12).map((f) => `  ${f.id} (${f.by}) ${clip(f.claim, 140)} [${f.artifact}:${f.start_line}]`);
    const hyps = this.hypotheses.map((h) => `  ${h.id} [${h.status}${h.review ? `, review: ${h.review.verdict}` : ''}] ${clip(h.statement, 200)} (support ${h.support.join(', ') || 'none'})`);
    const tasks = this.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').map((t) => `  ${t.id} ${t.role} P${t.priority} ${t.status}: ${clip(t.title, 100)}`);
    return [
      `Board v${this.version}`,
      `Facts (${this.facts.length} verified${this.facts.length > 12 ? ', latest 12 shown' : ''}):`,
      ...(facts.length ? facts : ['  none yet']),
      'Hypotheses:',
      ...(hyps.length ? hyps : ['  none yet']),
      'Open tasks:',
      ...(tasks.length ? tasks : ['  none']),
    ].join('\n');
  }

  snapshot() {
    return {
      version: this.version,
      facts: this.facts,
      hypotheses: this.hypotheses,
      tasks: this.tasks,
      messages: this.messages,
      mitigations: this.mitigations,
      rejected_facts: this.rejectedFacts,
      conclusion: this.conclusion,
      forced: this.forced,
    };
  }
}
