import type { ToolDef } from './tools.ts';

// Minimal tool-calling client for Meta Model API. Two wire formats are supported because
// the API exposes both: OpenAI-style Responses (/v1/responses) and Anthropic-style
// Messages (/v1/messages). Select with LLM_WIRE=responses|messages.

export const MODEL = process.env.MODEL ?? 'muse-wonder-1.0';
export const WIRE = (process.env.LLM_WIRE ?? 'responses') as 'responses' | 'messages';
const BASE_URL = (process.env.MODEL_BASE_URL ?? 'https://api.meta.ai').replace(/\/+$/, '');
const TIMEOUT_MS = 180_000;

export interface ToolCall {
  id: string;
  name: string;
  args: any;
  // Set when the model's arguments were not valid JSON.
  parseError?: string;
}

export interface Turn {
  text: string;
  calls: ToolCall[];
  usage: { input: number; output: number };
}

export interface Session {
  next(): Promise<Turn>;
  addToolResults(results: { id: string; output: string }[]): void;
  addUserMessage(text: string): void;
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

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}`, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    throw new ApiError(res.status, text);
  }
}

function parseArgs(id: string, name: string, raw: unknown): ToolCall {
  if (typeof raw !== 'string') return { id, name, args: raw ?? {} };
  try {
    return { id, name, args: raw.trim() ? JSON.parse(raw) : {} };
  } catch (err: any) {
    return { id, name, args: {}, parseError: err.message };
  }
}

function responsesSession(system: string, user: string, tools: ToolDef[]): Session {
  const input: any[] = [{ role: 'user', content: user }];
  const toolSpecs = tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
  return {
    async next() {
      const data = await post('/v1/responses', { model: MODEL, instructions: system, input, tools: toolSpecs, tool_choice: 'auto' });
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
      return { text, calls, usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 } };
    },
    addToolResults(results) {
      for (const r of results) input.push({ type: 'function_call_output', call_id: r.id, output: r.output });
    },
    addUserMessage(text) {
      input.push({ role: 'user', content: text });
    },
  };
}

function messagesSession(system: string, user: string, tools: ToolDef[]): Session {
  const messages: any[] = [{ role: 'user', content: user }];
  const toolSpecs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  let pendingResults: any[] = [];
  return {
    async next() {
      if (pendingResults.length) {
        messages.push({ role: 'user', content: pendingResults });
        pendingResults = [];
      }
      const data = await post(
        '/v1/messages',
        { model: MODEL, max_tokens: 16000, system, messages, tools: toolSpecs },
        { 'anthropic-version': '2023-06-01' },
      );
      const content: any[] = data.content ?? [];
      messages.push({ role: 'assistant', content });
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      const calls = content.filter((c) => c.type === 'tool_use').map((c) => parseArgs(c.id, c.name, c.input));
      return { text, calls, usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 } };
    },
    addToolResults(results) {
      pendingResults.push(...results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.output })));
    },
    addUserMessage(text) {
      if (pendingResults.length) {
        messages.push({ role: 'user', content: [...pendingResults, { type: 'text', text }] });
        pendingResults = [];
      } else {
        messages.push({ role: 'user', content: text });
      }
    },
  };
}

export function createSession(system: string, user: string, tools: ToolDef[]): Session {
  return WIRE === 'messages' ? messagesSession(system, user, tools) : responsesSession(system, user, tools);
}
