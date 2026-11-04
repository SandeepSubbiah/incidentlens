import { incidentBrief, learnCase, quarantineTracker, saveRun, stats, systemPrompt } from '../agent.ts';
import { loadConstitution } from '../guard/constitution.ts';
import { listArtifacts, loadGroundTruth, loadMeta, type LiveUpdate } from '../incidents.ts';
import { ApiError, createSession, MODELS, Usage, WIRE, type Session, type Tier, type ToolCall } from '../llm.ts';
import type { AgentEvent, Emit } from '../loop.ts';
import { gateRemediation } from '../remediation.ts';
import { scoreReport } from '../score.ts';
import { buildKnowledge, loadCases } from '../skills/knowledge.ts';
import { getRegistry, type RegistryView } from '../skills/registry.ts';
import { runTool, type ToolContext } from '../tools.ts';
import { verifyEvidence, verifyPatch, type PatchCheck } from '../verify.ts';
import { Board, ROLES, type Hypothesis, type Priority, type Role, type Task } from './board.ts';
import { toolsFor } from './tools.ts';

// The War Room: a commander, three fast specialists, a skeptic and a fixer working one incident
// in parallel over a shared, citation-gated board. Tasks are scheduled by priority; a more
// urgent task pauses a less urgent one at its next turn boundary, and the paused agent later
// resumes with a summary of what changed while it was away.

export interface WarRoomOptions {
  concurrency?: number;
  maxTurns?: number;
  maxCostUsd?: number;
  maxSeconds?: number;
  updates?: LiveUpdate[];
  view?: RegistryView;
  record?: boolean;
}

export const TIERS: Record<Role, Tier> = { commander: 'deep', skeptic: 'deep', fixer: 'deep', signals: 'fast', platform: 'fast', code: 'fast' };
const TASK_TURNS: Record<Role, number> = { commander: 6, signals: 10, platform: 10, code: 10, skeptic: 8, fixer: 8 };
const ARG_KEYS = ['path', 'pattern', 'query', 'to', 'role', 'title', 'task_id', 'hypothesis_id', 'priority', 'start_line', 'end_line', 'verdict', 'kind'];

const PROTOCOL = `## War Room protocol
- You are one agent in a team. The shared board holds verified facts (F#), hypotheses (H#), tasks (T#) and messages.
- Work on your current task. After each turn you receive the board changes since your last turn.
- post_fact is the only way evidence enters the board. Quotes are checked against the artifact; mismatches are rejected.
- ask_agent creates a task for another agent. Their answer arrives later as a board message: keep working meanwhile.
- Finish every task with the tool named in it. Keep results short and specific, and cite fact ids.`;

interface Agent {
  role: Role;
  session?: Session;
  current: Task | null;
  seen: number;
  nudged: boolean;
  rejections: number;
  fixRejected: boolean;
}

interface Outcome {
  role: Role;
  done: boolean;
  error?: unknown;
}

const clip = (s: unknown, n = 80) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const prio = (v: unknown, fallback: Priority): Priority => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 3 ? (n as Priority) : fallback;
};
const finisher = (t: Task) =>
  t.kind === 'review' ? 'challenge_hypothesis' : t.kind === 'fix' ? 'submit_fix' : t.kind === 'mitigate' ? 'submit_mitigation' : t.role === 'commander' ? 'complete_task (or conclude when ready)' : 'complete_task';
const live = (t: Task) => t.status === 'queued' || t.status === 'running' || t.status === 'parked';

export async function runWarRoom(incidentId: string, emit: Emit, opts: WarRoomOptions = {}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const send: Emit = (e) => {
    events.push(e);
    emit(e);
  };
  const started = Date.now();
  const usage = new Usage();
  const concurrency = opts.concurrency ?? Number(process.env.WARROOM_CONCURRENCY ?? 3);
  const maxTurns = opts.maxTurns ?? 60;
  const maxCost = opts.maxCostUsd ?? Number(process.env.WARROOM_MAX_COST_USD ?? 3);
  const maxSeconds = opts.maxSeconds ?? 600;
  let closed = false;

  try {
    const constitution = loadConstitution();
    const view = opts.view ?? (await getRegistry()).view();
    const meta = await loadMeta(incidentId);
    const artifacts = await listArtifacts(incidentId);
    const updates = opts.updates ?? meta.updates ?? [];
    const board = new Board(incidentId, send);
    const ctx: ToolContext = { caseId: incidentId, knowledge: buildKnowledge(view, await loadCases()), onQuarantine: quarantineTracker(send) };
    const brief = incidentBrief(meta, artifacts.length);
    send({ type: 'start', mode: 'warroom', incident: meta, model: MODELS.deep, models: MODELS, tiers: TIERS, wire: WIRE, artifacts: artifacts.length, concurrency, at: new Date().toISOString(), skills: { revision: view.revision, versions: view.versions(), candidate: view.overridden } });

    const agents = new Map<Role, Agent>(ROLES.map((r) => [r, { role: r, current: null, seen: 0, nudged: false, rejections: 0, fixRejected: false }]));
    const inflight = new Map<Role, Promise<Outcome>>();
    const injected = new Set<number>();
    let turns = 0;
    let toolCalls = 0;
    let stalls = 0;
    let budgetHit = false;
    let patchCheck: PatchCheck | null = null;

    const taskText = (t: Task) => `Your task ${t.id} (P${t.priority}, from ${t.createdBy}): ${t.title}\n${t.detail}\nFinish with ${finisher(t)}.`;

    const factLines = (h: Hypothesis) =>
      h.support
        .map((id) => board.facts.find((f) => f.id === id))
        .filter(Boolean)
        .map((f) => `- ${f!.id} (${f!.by}) ${f!.claim} [${f!.artifact}:${f!.start_line}] "${clip(f!.quote, 200)}"`)
        .join('\n');

    function enqueueReplan(reason: string, priority: Priority = 1) {
      const pending = board.tasks.find((t) => t.role === 'commander' && t.kind === 'replan' && (t.status === 'queued' || t.status === 'parked'));
      if (pending) {
        pending.detail += `\n- ${reason}`;
        if (priority < pending.priority) board.setPriority(pending, priority, 'system', reason);
        return;
      }
      board.addTask({ role: 'commander', kind: 'replan', title: 'Re-plan with new information', detail: `- ${reason}`, priority, createdBy: 'system' });
    }

    function finishTask(a: Agent, result: string, replanPriority: Priority = 1) {
      const t = a.current!;
      board.setStatus(t, 'done', result);
      a.current = null;
      if ((ROLES as string[]).includes(t.createdBy) && t.createdBy !== a.role) board.message(a.role, t.createdBy as Role, 'answer', `${t.id}: ${clip(result, 600)}`, t.id);
      if (a.role !== 'commander' && t.kind !== 'help' && t.kind !== 'fix') enqueueReplan(`${t.id} (${a.role}, ${t.kind}) finished: ${clip(result, 400)}`, replanPriority);
    }

    function start(t: Task) {
      const a = agents.get(t.role)!;
      const resumed = t.status === 'parked';
      a.current = t;
      board.setStatus(t, 'running');
      if (!a.session) {
        a.session = createSession({
          system: `${systemPrompt(constitution, view.get(t.role))}\n\n${PROTOCOL}`,
          user: `${brief}\n\nYou are the ${t.role} agent in this incident's War Room.\n\n${taskText(t)}\n\n${board.situation()}`,
          tools: toolsFor(t.role),
          tier: TIERS[t.role],
          usage,
          onHeal: (h) => send({ type: 'heal', role: t.role, ...h }),
        });
      } else {
        const changes = board.deltaFor(t.role, a.seen) || board.situation();
        a.session.addUserMessage(`${resumed ? `Resuming your task ${t.id} after higher-priority work.` : 'New task.'}\n${taskText(t)}\n\n${changes}`);
      }
      a.seen = board.version;
      send({ type: resumed ? 'resume' : 'assign', role: t.role, task: t.id, priority: t.priority, tier: a.session.tier });
    }

    function park(a: Agent, by: Task) {
      const t = a.current!;
      board.setStatus(t, 'parked');
      a.current = null;
      send({ type: 'preempt', role: a.role, task: t.id, priority: t.priority, by: by.id, by_role: by.role, by_priority: by.priority });
    }

    function schedule() {
      const waiting = board.tasks
        .filter((t) => t.status === 'queued' || t.status === 'parked')
        .sort((x, y) => x.priority - y.priority || Number(x.id.slice(1)) - Number(y.id.slice(1)));
      for (const t of waiting) {
        const owner = agents.get(t.role)!;
        const busy = () => [...agents.values()].filter((a) => a.current);
        if (!owner.current && busy().length < concurrency) {
          start(t);
          continue;
        }
        // Only agents between turns can be paused; one mid-call is paused at its next boundary.
        const pool = owner.current ? [owner] : busy().length >= concurrency ? busy() : [];
        const victim = pool
          .filter((a) => a.current && !inflight.has(a.role) && t.priority < a.current.priority)
          .sort((x, y) => y.current!.priority - x.current!.priority)[0];
        if (victim) {
          park(victim, t);
          if (!owner.current && busy().length < concurrency) start(t);
        }
      }
    }

    function launch() {
      for (const a of agents.values()) if (a.current && !inflight.has(a.role)) inflight.set(a.role, step(a));
    }

    async function step(a: Agent): Promise<Outcome> {
      const t = a.current!;
      try {
        const turn = await a.session!.next();
        if (closed) return { role: a.role, done: true };
        t.steps++;
        if (turn.text.trim()) send({ type: 'thought', role: a.role, task: t.id, text: clip(turn.text.trim(), 600), model: turn.model });
        if (!turn.calls.length) {
          if (!a.nudged) {
            a.nudged = true;
            a.session!.addUserMessage(`Use your tools to continue task ${t.id}, and finish with ${finisher(t)}.`);
            return { role: a.role, done: false };
          }
          finishTask(a, clip(turn.text.trim(), 1500) || 'No result given.');
          return { role: a.role, done: true };
        }
        a.nudged = false;
        const results: { id: string; output: string }[] = [];
        let done = false;
        for (const call of turn.calls.slice(0, 12)) {
          if (done) {
            results.push({ id: call.id, output: 'Skipped: your task already finished.' });
            continue;
          }
          const r = await handleCall(a, t, call, turn.model);
          results.push({ id: call.id, output: r.output });
          done = r.done;
        }
        a.session!.addToolResults(results);
        if (!done) {
          const delta = board.deltaFor(a.role, a.seen);
          if (delta) a.session!.addUserMessage(delta);
          if (t.steps >= TASK_TURNS[a.role] + 2) {
            finishTask(a, 'Stopped: turn budget for this task exhausted.');
            done = true;
          } else if (t.steps >= TASK_TURNS[a.role]) {
            a.session!.addUserMessage(`Turn budget for ${t.id} is nearly exhausted. Finish now with ${finisher(t)}.`);
          }
        }
        a.seen = board.version;
        return { role: a.role, done };
      } catch (error) {
        return { role: a.role, done: true, error };
      }
    }

    async function handleCall(a: Agent, t: Task, call: ToolCall, model: string): Promise<{ output: string; done: boolean }> {
      const args = call.args ?? {};
      const t0 = Date.now();
      toolCalls++;
      const log = (label: string, error?: string) =>
        send({ type: 'step', n: toolCalls, role: a.role, task: t.id, tool: call.name, args: Object.fromEntries(Object.entries(args).filter(([k]) => ARG_KEYS.includes(k))), label, ms: Date.now() - t0, model, ...(error ? { error } : {}) });
      const fail = (label: string, output: string) => {
        log(label, output);
        return { output: `Error: ${output}`, done: false };
      };
      if (call.parseError) return fail(`${call.name}: invalid arguments`, `arguments were not valid JSON (${call.parseError})`);
      try {
        switch (call.name) {
          case 'list_artifacts':
          case 'read_artifact':
          case 'search_artifacts':
          case 'search_runbooks': {
            const r = await runTool(ctx, call.name, args);
            log(r.label);
            return { output: r.output, done: false };
          }
          case 'post_fact': {
            const r = await board.postFact(a.role, args);
            if (!r.ok) {
              a.rejections++;
              log(`Fact rejected: ${r.reason}`, r.reason);
              if (a.rejections >= 2 && a.session!.tier === 'fast') {
                a.session!.escalate();
                send({ type: 'escalate', role: a.role, from: MODELS.fast, to: MODELS.deep, reason: `${a.rejections} rejected facts in a row` });
              }
              return { output: `Rejected: ${r.reason}. Re-read the artifact and post the exact text with correct line numbers.`, done: false };
            }
            a.rejections = 0;
            log(r.duplicate ? `Fact already on board as ${r.fact.id}` : `Posted ${r.fact.id}`);
            return { output: `${r.duplicate ? 'Already on the board as' : 'Posted'} ${r.fact.id}${r.fact.corrected_from ? ` (line numbers corrected from ${r.fact.corrected_from} to ${r.fact.start_line})` : ''}.`, done: false };
          }
          case 'propose_hypothesis': {
            const ids = arr(args.fact_ids).map(String);
            const missing = board.missingFacts(ids);
            if (!ids.length || missing.length) return fail('Hypothesis rejected', `a hypothesis must cite existing verified fact ids${missing.length ? `; unknown: ${missing.join(', ')}` : ''}`);
            const h = board.proposeHypothesis(a.role, String(args.statement ?? ''), ids);
            log(`Proposed ${h.id}`);
            return { output: `Created ${h.id}.`, done: false };
          }
          case 'update_hypothesis': {
            const h = board.hypothesis(String(args.id));
            if (!h) return fail('Unknown hypothesis', `no hypothesis ${args.id}`);
            const ids = [...arr(args.support), ...arr(args.against)].map(String);
            const missing = board.missingFacts(ids);
            if (missing.length) return fail('Unknown facts', `unknown fact ids: ${missing.join(', ')}`);
            board.updateHypothesis(h, a.role, { status: args.status, support: arr(args.support).map(String), against: arr(args.against).map(String), reason: String(args.reason ?? '') });
            log(`${h.id} -> ${h.status}`);
            return { output: `${h.id} is now ${h.status}.`, done: false };
          }
          case 'ask_agent': {
            const to = args.to as Role;
            if (!ROLES.includes(to) || to === a.role) return fail('ask_agent rejected', 'choose another agent: commander, signals, platform, code, skeptic or fixer');
            const question = String(args.question ?? '');
            const help = board.addTask({ role: to, kind: 'help', title: `Help ${a.role}: ${clip(question, 70)}`, detail: `${a.role} asks: ${question}`, priority: prio(args.priority, t.priority), createdBy: a.role });
            board.message(a.role, to, 'help', question, help.id);
            log(`Asked ${to} (${help.id})`);
            return { output: `Created ${help.id} for ${to}. The answer will arrive as a board message; continue your task.`, done: false };
          }
          case 'create_task': {
            const role = args.role as Role;
            if (!ROLES.includes(role) || role === 'commander') return fail('create_task rejected', 'role must be signals, platform, code, skeptic or fixer');
            const kind = ['investigate', 'mitigate', 'review', 'fix'].includes(args.kind) ? args.kind : 'investigate';
            const nt = board.addTask({ role, kind, title: String(args.title ?? 'Task'), detail: String(args.detail ?? ''), priority: prio(args.priority, 2), createdBy: 'commander' });
            log(`Created ${nt.id} for ${role} (P${nt.priority})`);
            return { output: `Created ${nt.id}.`, done: false };
          }
          case 'set_priority': {
            const target = board.task(String(args.task_id));
            if (!target || !live(target)) return fail('set_priority rejected', `no open task ${args.task_id}`);
            board.setPriority(target, prio(args.priority, target.priority), a.role, String(args.reason ?? ''));
            log(`${target.id} -> P${target.priority}`);
            return { output: `${target.id} is now P${target.priority}.`, done: false };
          }
          case 'cancel_task': {
            const target = board.task(String(args.task_id));
            if (!target || !(target.status === 'queued' || target.status === 'parked')) return fail('cancel_task rejected', `${args.task_id} is not queued or paused`);
            board.setStatus(target, 'cancelled', String(args.reason ?? ''));
            log(`Cancelled ${target.id}`);
            return { output: `Cancelled ${target.id}.`, done: false };
          }
          case 'complete_task': {
            finishTask(a, String(args.result ?? ''));
            log('Completed task');
            return { output: 'Task completed.', done: true };
          }
          case 'conclude': {
            const h = board.hypothesis(String(args.hypothesis_id));
            if (!h) return fail('Conclusion rejected', `no hypothesis ${args.hypothesis_id}`);
            if (h.status === 'refuted') return fail('Conclusion rejected', `${h.id} was refuted: ${h.review?.reason ?? ''}`);
            const needed = board.forced ? 1 : 2;
            if (h.support.length < needed) return fail('Conclusion rejected', `${h.id} needs at least ${needed} verified supporting facts and has ${h.support.length}; gather more evidence or add support with update_hypothesis`);
            if (!board.forced && !h.review) {
              const existing = board.tasks.find((x) => x.kind === 'review' && x.hypothesis === h.id && live(x));
              const rt = existing ?? board.addTask({ role: 'skeptic', kind: 'review', hypothesis: h.id, title: `Try to disprove ${h.id}`, detail: `Hypothesis ${h.id} (by ${h.by}): ${h.statement}\nSupporting facts:\n${factLines(h)}`, priority: 1, createdBy: 'commander' });
              log('Conclusion blocked: skeptic review required', 'review required');
              return { output: `Not yet: ${h.id} needs a skeptic review first (${rt.id}). Finish this task with complete_task; you will be asked to re-plan when the review is in.`, done: false };
            }
            board.conclusion = {
              hypothesis: h.id,
              summary: String(args.summary ?? ''),
              root_cause: String(args.root_cause ?? ''),
              category: String(args.category ?? 'other'),
              confidence: Number(args.confidence ?? 0),
              timeline: arr(args.timeline),
              next_steps: arr(args.next_steps).map(String),
              ruled_out: arr(args.ruled_out),
              forced: board.forced,
            };
            board.updateHypothesis(h, a.role, { status: 'supported', reason: 'concluded by commander' });
            send({ type: 'conclusion', conclusion: board.conclusion });
            if (!board.tasks.some((x) => x.kind === 'fix' && x.status !== 'cancelled' && x.status !== 'failed')) {
              board.addTask({ role: 'fixer', kind: 'fix', hypothesis: h.id, title: `Mitigation, permanent fix and regression test for ${h.id}`, detail: `Conclusion: ${board.conclusion.summary}\nRoot cause: ${board.conclusion.root_cause}\nSupporting facts:\n${factLines(h)}`, priority: budgetHit ? 0 : 1, createdBy: 'commander' });
            }
            finishTask(a, `Concluded on ${h.id}: ${board.conclusion.summary}`);
            log(`Concluded on ${h.id}`);
            return { output: 'Concluded. The fixer will now write the patch.', done: true };
          }
          case 'challenge_hypothesis': {
            const h = board.hypothesis(String(args.hypothesis_id));
            if (!h) return fail('Review rejected', `no hypothesis ${args.hypothesis_id}`);
            const verdict = ['stands', 'weakened', 'refuted'].includes(args.verdict) ? args.verdict : 'weakened';
            const ids = arr(args.fact_ids).map(String);
            const missing = board.missingFacts(ids);
            if (missing.length) return fail('Review rejected', `unknown fact ids: ${missing.join(', ')}`);
            if (verdict === 'refuted' && !ids.length) return fail('Review rejected', 'refuting requires at least one verified fact id');
            board.review(h, a.role, verdict, String(args.reason ?? ''), ids);
            log(`Review of ${h.id}: ${verdict}`);
            finishTask(a, `${h.id} ${verdict}: ${String(args.reason ?? '')}`, verdict === 'refuted' ? 0 : 1);
            return { output: 'Review recorded.', done: true };
          }
          case 'submit_mitigation': {
            const steps = arr(args.steps).map(String).filter(Boolean);
            if (!steps.length) return fail('Mitigation rejected', 'provide at least one step');
            board.addMitigation(a.role, steps, String(args.rationale ?? ''));
            log('Mitigation recorded');
            if (t.kind === 'mitigate') {
              finishTask(a, `Mitigation: ${steps.join('; ')}`);
              return { output: 'Mitigation recorded; task complete.', done: true };
            }
            return { output: 'Mitigation recorded.', done: false };
          }
          case 'submit_fix': {
            const fix = {
              artifact: String(args.artifact ?? ''),
              explanation: String(args.explanation ?? ''),
              patch: String(args.patch ?? ''),
              regression_test: args.regression_test ?? { name: '', language: '', code: '' },
              mitigation: arr(args.mitigation).map(String),
            };
            const check = await verifyPatch(incidentId, fix);
            const ok = check.status === 'applies' || check.status === 'no_removals';
            send({ type: 'fix_check', role: a.role, patch: check, accepted: ok || a.fixRejected });
            if (!ok && !a.fixRejected) {
              a.fixRejected = true;
              log('Patch rejected by verifier', check.status);
              const why = check.missing.length ? `these lines do not exist in ${fix.artifact}: ${check.missing.slice(0, 5).map((l) => JSON.stringify(l)).join(', ')}` : `artifact ${fix.artifact} not found`;
              return { output: `Verification rejected the patch (${check.status}): ${why}. Re-read the artifact and submit again.`, done: false };
            }
            board.fix = fix;
            patchCheck = check;
            if (fix.mitigation.length) board.addMitigation(a.role, fix.mitigation, 'submitted with the fix');
            log(ok ? 'Patch verified' : 'Patch accepted after revision limit', ok ? undefined : check.status);
            finishTask(a, `Fix for ${fix.artifact}: ${clip(fix.explanation, 300)}`);
            return { output: 'Fix recorded.', done: true };
          }
          default:
            return fail(`Unknown tool ${call.name}`, `unknown tool ${call.name}`);
        }
      } catch (err: any) {
        return fail(`${call.name} failed`, err.message);
      }
    }

    board.addTask({ role: 'commander', kind: 'plan', title: 'Triage the incident and plan the investigation', detail: 'Read the alert, list the artifacts, and create parallel tasks for the specialists.', priority: 1, createdBy: 'system' });

    while (!(board.conclusion && board.fix)) {
      const elapsed = (Date.now() - started) / 1000;
      if (!budgetHit && (turns >= maxTurns || usage.cost >= maxCost || elapsed >= maxSeconds)) {
        budgetHit = true;
        board.forced = true;
        send({ type: 'budget', turns, cost_usd: usage.cost, seconds: Math.round(elapsed) });
        for (const x of board.tasks) if ((x.status === 'queued' || x.status === 'parked') && x.role !== 'commander' && x.kind !== 'fix') board.setStatus(x, 'cancelled', 'budget exhausted');
        if (!board.conclusion) board.addTask({ role: 'commander', kind: 'replan', title: 'Budget exhausted: conclude now', detail: 'Conclude on the best-supported hypothesis now; one verified fact is enough.', priority: 0, createdBy: 'system' });
      }
      if (budgetHit && turns >= maxTurns + 12) throw new Error('budget exhausted without a conclusion and a fix');

      updates.forEach((u, i) => {
        if (injected.has(i) || turns < u.after_turns) return;
        injected.add(i);
        board.message(u.from, 'all', 'update', u.text);
        board.addTask({ role: 'commander', kind: 'update', title: `Respond to live update from ${u.from}`, detail: u.text, priority: u.priority ?? 0, createdBy: u.from });
        send({ type: 'live_update', from: u.from, text: u.text, priority: u.priority ?? 0 });
      });

      schedule();
      launch();
      if (!inflight.size) {
        if (++stalls > 3) throw new Error('war room stalled: no runnable tasks and no conclusion');
        if (!board.conclusion) enqueueReplan('No agent is working. Create tasks for the open questions, or conclude.', budgetHit ? 0 : 1);
        else if (!board.tasks.some((x) => x.kind === 'fix' && live(x))) board.addTask({ role: 'fixer', kind: 'fix', title: 'Write the fix', detail: `Conclusion: ${board.conclusion.summary}`, priority: 1, createdBy: 'system' });
        continue;
      }
      stalls = 0;
      const outcome = await Promise.race(inflight.values());
      inflight.delete(outcome.role);
      turns++;
      if (outcome.error) {
        const err = outcome.error as any;
        if (err instanceof ApiError && [401, 402, 403].includes(err.status)) throw err;
        const a = agents.get(outcome.role)!;
        if (a.current) board.setStatus(a.current, 'failed', err.message);
        a.current = null;
        send({ type: 'agent_error', role: outcome.role, message: String(err.message ?? err) });
      }
    }
    closed = true;
    for (const x of board.tasks) if (x.status === 'queued' || x.status === 'parked') board.setStatus(x, 'cancelled', 'investigation concluded');

    const c = board.conclusion!;
    const fix = board.fix!;
    const h = board.hypothesis(c.hypothesis)!;
    const evidence = h.support
      .map((id) => board.facts.find((f) => f.id === id))
      .filter((f) => !!f)
      .map((f) => ({ artifact: f!.artifact, start_line: f!.start_line, end_line: f!.end_line, quote: f!.quote, supports: f!.claim }));
    const report = {
      summary: c.summary,
      root_cause: c.root_cause,
      category: c.category,
      confidence: c.confidence,
      timeline: c.timeline,
      evidence,
      ruled_out: [...board.hypotheses.filter((x) => x.status === 'refuted').map((x) => ({ hypothesis: x.statement, reason: x.review?.reason ?? 'refuted on the board' })), ...c.ruled_out],
      fix: { artifact: fix.artifact, explanation: fix.explanation, patch: fix.patch },
      regression_test: fix.regression_test,
      next_steps: c.next_steps,
      mitigation: [...new Set(board.mitigations.flatMap((m) => m.steps))],
    };
    const checks = await Promise.all(evidence.map((e) => verifyEvidence(incidentId, e)));
    const patch = patchCheck ?? (await verifyPatch(incidentId, report.fix));
    const score = scoreReport(report, await loadGroundTruth(incidentId));
    const gate = await gateRemediation(incidentId, meta, report, 'warroom', opts.record !== false && !view.overridden.length);
    send({ type: 'report', report, checks, patch, score, stats: { ...stats(toolCalls, started, usage), turns }, revised: false, forced: c.forced, board: board.snapshot(), ...gate });
    if (score.correct && checks.every((x) => x.status === 'verified') && !view.overridden.length) await learnCase(meta, report);
  } catch (err: any) {
    closed = true;
    send({ type: 'error', message: err.message });
  } finally {
    if (opts.record !== false) await saveRun(incidentId, events).catch(() => {});
  }
  return events;
}
