import { createSession, type Heal, type Tier, type Usage } from './llm.ts';
import { runTool, type ToolContext, type ToolDef } from './tools.ts';

// Single-agent tool loop shared by the solo investigator and the self-repair doctor. The
// caller decides what a submission means via onSubmit.

export type AgentEvent = { type: string; [key: string]: any };
export type Emit = (e: AgentEvent) => void;

export type SubmitOutcome = { done: true } | { done: false; feedback: string };

export interface LoopOptions {
  system: string;
  user: string;
  tools: ToolDef[];
  submitName: string;
  tier: Tier;
  ctx: ToolContext;
  usage: Usage;
  send: Emit;
  maxSteps?: number;
  onSubmit: (args: any, state: { steps: number }) => Promise<SubmitOutcome>;
}

export async function runToolLoop(o: LoopOptions): Promise<{ steps: number }> {
  const maxSteps = o.maxSteps ?? 30;
  const session = createSession({
    system: o.system,
    user: o.user,
    tools: o.tools,
    tier: o.tier,
    usage: o.usage,
    onHeal: (h: Heal) => o.send({ type: 'heal', ...h }),
  });
  let steps = 0;
  let nudged = false;

  for (let turnNo = 0; turnNo < maxSteps + 5; turnNo++) {
    const turn = await session.next();
    if (turn.text.trim()) o.send({ type: 'thought', text: turn.text.trim(), model: turn.model });

    if (!turn.calls.length) {
      if (nudged) throw new Error(`model stopped without calling ${o.submitName}`);
      nudged = true;
      session.addUserMessage(`Continue using the tools, and finish by calling ${o.submitName}.`);
      continue;
    }

    const results: { id: string; output: string }[] = [];
    for (const call of turn.calls) {
      if (call.parseError) {
        results.push({ id: call.id, output: `Error: arguments were not valid JSON (${call.parseError}). Retry.` });
        continue;
      }
      if (call.name === o.submitName) {
        const outcome = await o.onSubmit(call.args, { steps });
        if (outcome.done) return { steps };
        results.push({ id: call.id, output: outcome.feedback });
        continue;
      }
      steps++;
      const t0 = Date.now();
      try {
        const r = await runTool(o.ctx, call.name, call.args);
        results.push({ id: call.id, output: r.output });
        o.send({ type: 'step', n: steps, tool: call.name, args: call.args, label: r.label, ms: Date.now() - t0, model: turn.model });
      } catch (err: any) {
        results.push({ id: call.id, output: `Error: ${err.message}` });
        o.send({ type: 'step', n: steps, tool: call.name, args: call.args, label: `${call.name} failed`, ms: Date.now() - t0, error: err.message, model: turn.model });
      }
    }
    session.addToolResults(results);
    if (steps >= maxSteps - 2) {
      session.addUserMessage(`Tool budget nearly exhausted (${steps}/${maxSteps}). Call ${o.submitName} now with your best-supported conclusion.`);
    }
  }
  throw new Error(`no ${o.submitName} after ${maxSteps} tool calls`);
}
