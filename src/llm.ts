import { inOutage } from './chaos.ts';
import type { ToolDef } from './tools.ts';

// Tool-calling client for Meta Model API with two model tiers and runtime reflexes:
// per-model circuit breakers with failover to the other tier, Retry-After on 429, and
// negotiation of optional request parameters the endpoint turns out not to accept.

export type Tier = 'fast' | 'deep';

export const MODELS: Record<Tier, string> = {
  deep: process.env.MODEL_DEEP ?? process.env.MODEL ?? 'muse-wonder-1.0',
  fast: process.env.MODEL_FAST ?? 'muse-spark-1.3',
};
export const MODEL = MODELS.deep;
export const WIRE = (process.env.LLM_WIRE ?? 'responses') as 'responses' | 'messages';
const BASE_URL = (process.env.MODEL_BASE_URL ?? 'https://api.meta.ai').replace(/\/+$/, '');
const TIMEOUT_MS = 180_000;
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = Number(process.env.BREAKER_COOLDOWN_MS ?? 60_000);
const EFFORT: Record<Tier, string> = { deep: process.env.REASONING_DEEP ?? 'high', fast: process.env.REASONING_FAST ?? 'low' };

// USD per million tokens (dev.meta.ai/docs/pricing-rate-limits, 2026-11).
export const PRICING: Record<string, { input: number; cached: number; output: number }> = {
  'muse-wonder-1.0': { input: 4, cached: 0.2, output: 20 },
  'muse-spark-1.3': { input: 1.25, cached: 0.15, output: 4.25 },
  'muse-spark-1.3-contributor': { input: 0.1, cached: 0.002, output: 0.2 },
};

export class Usage {
  byModel: Record<string, { input: number; cached: number; output: number; calls: number }> = {};

  add(model: string, u: { input: number; cached: number; output: number }) {
    const m = (this.byModel[model] ??= { input: 0, cached: 0, output: 0, calls: 0 });
    m.input += u.input;
    m.cached += u.cached;
    m.output += u.output;
    m.calls++;
  }

  get input() {
    return Object.values(this.byModel).reduce((n, m) => n + m.input, 0);
  }

  get output() {
    return Object.values(this.byModel).reduce((n, m) => n + m.output, 0);
  }

  get cost(): number {
    let usd = 0;
    for (const [model, m] of Object.entries(this.byModel)) {
      const p = PRICING[model];
      if (p) usd += ((m.input - m.cached) * p.input + m.cached * p.cached + m.output * p.output) / 1e6;
    }
    return Math.round(usd * 10000) / 10000;
  }
}

export interface ToolCall {
  id: string;
  name: string;
  args: any;
  parseError?: string;
}

export interface Turn {
  text: string;
  calls: ToolCall[];
  model: string;
}

export interface Heal {
  kind: 'failover' | 'circuit-open' | 'circuit-closed' | 'param-negotiation' | 'history-compat' | 'rate-limited';
  detail: string;
}

export interface Session {
  readonly tier: Tier;
  next(): Promise<Turn>;
  addToolResults(results: { id: string; output: string }[]): void;
  addUserMessage(text: string): void;
  escalate(): void;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`Meta Model API ${status}: ${body.slice(0, 500)}`);
    this.status = status;
  }
}

function apiKey(): string {
  const key = process.env.MODEL_API_KEY;
  if (!key) throw new Error('MODEL_API_KEY is not set');
  return key;
}

function retryAfterMs(res: Response, attempt: number): number {
  const h = res.headers.get('retry-after');
  const secs = h && /^\d+(\.\d+)?$/.test(h) ? Number(h) : h ? (Date.parse(h) - Date.now()) / 1000 : NaN;
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, 30_000) : 1000 * 2 ** attempt;
}

async function post(path: string, model: string, body: unknown, headers: Record<string, string>, onHeal: (h: Heal) => void): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    if (inOutage(model)) throw new ApiError(503, `simulated outage of ${model} (chaos)`);
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}`, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    if (res.status === 429 && attempt < 4) {
      const wait = retryAfterMs(res, attempt);
      onHeal({ kind: 'rate-limited', detail: `429 from ${model}; waiting ${Math.round(wait / 1000)}s as instructed` });
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    // One quick retry for a transient 5xx; after that the caller's breaker and failover take over.
    if (res.status >= 500 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    throw new ApiError(res.status, text);
  }
}

// Process-wide reflex state: shared by every session so one run's lesson protects the next.
const breakers = new Map<string, { failures: number; openUntil: number }>();
const rejectedParams = new Set<string>();

export function reflexState() {
  return {
    breakers: Object.fromEntries([...breakers.entries()].map(([m, b]) => [m, { failures: b.failures, open: b.openUntil > Date.now(), open_until: b.openUntil ? new Date(b.openUntil).toISOString() : null }])),
    rejected_params: [...rejectedParams],
  };
}

export function resetReflexes() {
  breakers.clear();
  rejectedParams.clear();
}

function breakerOpen(model: string) {
  return (breakers.get(model)?.openUntil ?? 0) > Date.now();
}

function recordFailure(model: string, onHeal: (h: Heal) => void) {
  const b = breakers.get(model) ?? { failures: 0, openUntil: 0 };
  b.failures++;
  if (b.failures >= BREAKER_THRESHOLD && b.openUntil <= Date.now()) {
    b.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    onHeal({ kind: 'circuit-open', detail: `${model} failed ${b.failures} times; routing around it for ${BREAKER_COOLDOWN_MS / 1000}s` });
  }
  breakers.set(model, b);
}

function recordSuccess(model: string, onHeal: (h: Heal) => void) {
  const b = breakers.get(model);
  if (b && b.failures >= BREAKER_THRESHOLD) onHeal({ kind: 'circuit-closed', detail: `${model} healthy again; circuit closed` });
  breakers.delete(model);
}

const healable = (err: unknown) => !(err instanceof ApiError) || err.status === 429 || err.status >= 500;

function parseArgs(id: string, name: string, raw: unknown): ToolCall {
  if (typeof raw !== 'string') return { id, name, args: raw ?? {} };
  try {
    return { id, name, args: raw.trim() ? JSON.parse(raw) : {} };
  } catch (err: any) {
    return { id, name, args: {}, parseError: err.message };
  }
}

interface Wire {
  path: string;
  headers: Record<string, string>;
  body(model: string, tier: Tier, opts: { optional: boolean; stripReasoning: boolean }): unknown;
  accept(data: any): { text: string; calls: ToolCall[]; usage: { input: number; cached: number; output: number } };
  addToolResults(results: { id: string; output: string }[]): void;
  addUserMessage(text: string): void;
}

function responsesWire(system: string, user: string, tools: ToolDef[]): Wire {
  const input: any[] = [{ role: 'user', content: user }];
  const toolSpecs = tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
  return {
    path: '/v1/responses',
    headers: {},
    body(model, tier, { optional, stripReasoning }) {
      const items = stripReasoning ? input.filter((i) => i.type !== 'reasoning') : input;
      const body: any = { model, instructions: system, input: items, tools: toolSpecs, tool_choice: 'auto' };
      if (optional && EFFORT[tier] !== 'off') body.reasoning = { effort: EFFORT[tier] };
      return body;
    },
    accept(data) {
      const output: any[] = data.output ?? [];
      // Echo the model's own output items back so the next turn has the full history.
      input.push(...output);
      const text = output
        .filter((o) => o.type === 'message')
        .flatMap((o) => o.content ?? [])
        .filter((c: any) => c.type === 'output_text')
        .map((c: any) => c.text)
        .join('\n');
      const calls = output.filter((o) => o.type === 'function_call').map((o) => parseArgs(o.call_id, o.name, o.arguments));
      const u = data.usage ?? {};
      return { text, calls, usage: { input: u.input_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0, output: u.output_tokens ?? 0 } };
    },
    addToolResults(results) {
      for (const r of results) input.push({ type: 'function_call_output', call_id: r.id, output: r.output });
    },
    addUserMessage(text) {
      input.push({ role: 'user', content: text });
    },
  };
}

function messagesWire(system: string, user: string, tools: ToolDef[]): Wire {
  const messages: any[] = [{ role: 'user', content: user }];
  const toolSpecs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  let pending: any[] = [];
  const flush = () => {
    if (pending.length) {
      messages.push({ role: 'user', content: pending });
      pending = [];
    }
  };
  return {
    path: '/v1/messages',
    headers: { 'anthropic-version': '2023-06-01' },
    body(model) {
      flush();
      return { model, max_tokens: 16000, system, messages, tools: toolSpecs };
    },
    accept(data) {
      const content: any[] = data.content ?? [];
      messages.push({ role: 'assistant', content });
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      const calls = content.filter((c) => c.type === 'tool_use').map((c) => parseArgs(c.id, c.name, c.input));
      const u = data.usage ?? {};
      return { text, calls, usage: { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 } };
    },
    addToolResults(results) {
      pending.push(...results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.output })));
    },
    addUserMessage(text) {
      pending.push({ type: 'text', text });
      flush();
    },
  };
}

export function createSession(o: { system: string; user: string; tools: ToolDef[]; tier?: Tier; usage?: Usage; onHeal?: (h: Heal) => void }): Session {
  const wire = WIRE === 'messages' ? messagesWire(o.system, o.user, o.tools) : responsesWire(o.system, o.user, o.tools);
  const onHeal = o.onHeal ?? (() => {});
  let tier: Tier = o.tier ?? 'deep';
  let stripReasoning = false;

  async function call(model: string): Promise<Turn> {
    const optional = WIRE === 'responses' && !rejectedParams.has('reasoning');
    try {
      const data = await post(wire.path, model, wire.body(model, tier, { optional, stripReasoning }), wire.headers, onHeal);
      return finish(model, data);
    } catch (err) {
      // A 400 after sending optional parameters: retry without them once and remember.
      if (err instanceof ApiError && (err.status === 400 || err.status === 422) && optional) {
        rejectedParams.add('reasoning');
        onHeal({ kind: 'param-negotiation', detail: `endpoint rejected optional reasoning settings; continuing without them (${err.message.slice(0, 120)})` });
        try {
          return finish(model, await post(wire.path, model, wire.body(model, tier, { optional: false, stripReasoning }), wire.headers, onHeal));
        } catch (again) {
          err = again;
        }
      }
      // A 400 after a model switch can come from the other model's reasoning items in history.
      if (err instanceof ApiError && err.status === 400 && WIRE === 'responses' && !stripReasoning) {
        stripReasoning = true;
        onHeal({ kind: 'history-compat', detail: 'dropped prior reasoning items from history after the endpoint rejected them' });
        return finish(model, await post(wire.path, model, wire.body(model, tier, { optional: false, stripReasoning }), wire.headers, onHeal));
      }
      throw err;
    }
  }

  function finish(model: string, data: any): Turn {
    const r = wire.accept(data);
    o.usage?.add(model, r.usage);
    return { text: r.text, calls: r.calls, model };
  }

  return {
    get tier() {
      return tier;
    },
    async next() {
      const primary = MODELS[tier];
      const backup = MODELS[tier === 'deep' ? 'fast' : 'deep'];
      if (breakerOpen(primary) && primary !== backup) {
        onHeal({ kind: 'failover', detail: `${primary} circuit open; using ${backup}` });
        return call(backup);
      }
      try {
        const turn = await call(primary);
        recordSuccess(primary, onHeal);
        return turn;
      } catch (err) {
        if (!healable(err) || primary === backup) throw err;
        recordFailure(primary, onHeal);
        onHeal({ kind: 'failover', detail: `${primary} failed (${(err as Error).message.slice(0, 100)}); retrying on ${backup}` });
        return call(backup);
      }
    },
    addToolResults: (results) => wire.addToolResults(results),
    addUserMessage: (text) => wire.addUserMessage(text),
    escalate() {
      tier = 'deep';
    },
  };
}
