import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { RUNS_DIR } from './agent.ts';
import { modelEndpoint, priceOf, PRICING, type Usage } from './llm.ts';
import { dataDir } from './paths.ts';

// Model spend that IncidentLens itself recorded, by operation and by calendar period.
// Sources: run records (investigations, including evals) and a spend ledger for model calls that
// leave no run record (the self-repair Doctor and its canary validations). Every figure is an
// estimate from token counts at Meta's published prices: the Meta Model API has no billing or
// balance endpoint, and anything else using the same API key is invisible here.

type Kind = 'investigation' | 'self-repair' | 'canary';
type Inference = 'live' | 'scripted' | 'not recorded';
type ModelUse = { input: number; cached: number; output: number; calls: number; served?: string };

interface Item {
  at: string;
  kind: Kind;
  mode?: string;
  incident?: string;
  inference: Inference;
  models: Record<string, ModelUse>;
  cost_usd: number;
}

const ledgerFile = () => path.join(dataDir(), 'spend.jsonl');
const round = (n: number) => Math.round(n * 10000) / 10000;
const costOf = (models: Record<string, ModelUse>) => round(Object.entries(models).reduce((n, [m, u]) => n + priceOf(m, u), 0));

// For model calls that leave no run record. Never throws: losing a cost line must not break repair.
export async function recordSpend(kind: Kind, models: Usage['byModel'], extra: { incident?: string } = {}) {
  if (!Object.keys(models).length) return;
  const entry: Item = { at: new Date().toISOString(), kind, ...extra, inference: modelEndpoint().live ? 'live' : 'scripted', models, cost_usd: costOf(models) };
  await mkdir(dataDir(), { recursive: true }).catch(() => {});
  await appendFile(ledgerFile(), JSON.stringify(entry) + '\n').catch(() => {});
}

async function runItems(): Promise<{ items: Item[]; synthetic: number }> {
  const items: Item[] = [];
  let synthetic = 0;
  for (const dir of await readdir(RUNS_DIR).catch(() => [] as string[])) {
    for (const f of (await readdir(path.join(RUNS_DIR, dir)).catch(() => [] as string[])).filter((x) => x.endsWith('.json'))) {
      const run = JSON.parse(await readFile(path.join(RUNS_DIR, dir, f), 'utf8').catch(() => '{}'));
      const start = run.events?.find((e: any) => e.type === 'start');
      if (!start) continue;
      if (start.synthetic) {
        synthetic++;
        continue;
      }
      const end = run.events.find((e: any) => e.type === 'report')?.stats ?? run.events.find((e: any) => e.type === 'error')?.usage;
      const models: Record<string, ModelUse> = end?.models ?? {};
      items.push({ at: start.at, kind: 'investigation', mode: start.mode, incident: dir, inference: start.provenance?.inference ?? 'not recorded', models, cost_usd: costOf(models) });
    }
  }
  return { items, synthetic };
}

async function ledgerItems(): Promise<Item[]> {
  const raw = await readFile(ledgerFile(), 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l) as Item];
    } catch {
      return [];
    }
  });
}

// Calendar keys in the server's local time zone.
function keys(d: Date) {
  const y = d.getFullYear();
  const m = d.getMonth();
  const monday = new Date(y, m, d.getDate() - ((d.getDay() + 6) % 7));
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { day: iso(d), week: iso(monday), month: `${y}-${String(m + 1).padStart(2, '0')}`, quarter: `${y}-Q${Math.floor(m / 3) + 1}`, half: `${y}-H${m < 6 ? 1 : 2}`, year: String(y) };
}

type Bucket = { usd: number; operations: number; calls: number };
const add = (b: Bucket | undefined, i: Item): Bucket => ({
  usd: round((b?.usd ?? 0) + i.cost_usd),
  operations: (b?.operations ?? 0) + 1,
  calls: (b?.calls ?? 0) + Object.values(i.models).reduce((n, u) => n + (u.calls ?? 0), 0),
});
const empty = (): Bucket => ({ usd: 0, operations: 0, calls: 0 });

export async function spendSummary(now = new Date()) {
  const { items: runs, synthetic } = await runItems();
  const items = [...runs, ...(await ledgerItems())].sort((a, b) => b.at.localeCompare(a.at));
  const k = keys(now);
  const periods = { today: empty(), week: empty(), month: empty(), quarter: empty(), half: empty(), year: empty(), all: empty() };
  const by: Record<'month' | 'quarter' | 'half' | 'year', Record<string, Bucket>> = { month: {}, quarter: {}, half: {}, year: {} };
  const byModel: Record<string, { served: Set<string>; calls: number; usd: number }> = {};
  const byKind: Record<string, Bucket> = {};
  const byInference: Record<string, Bucket> = {};
  for (const i of items) {
    const ik = keys(new Date(i.at));
    if (ik.day === k.day) periods.today = add(periods.today, i);
    if (ik.week === k.week) periods.week = add(periods.week, i);
    if (ik.month === k.month) periods.month = add(periods.month, i);
    if (ik.quarter === k.quarter) periods.quarter = add(periods.quarter, i);
    if (ik.half === k.half) periods.half = add(periods.half, i);
    if (ik.year === k.year) periods.year = add(periods.year, i);
    periods.all = add(periods.all, i);
    for (const p of ['month', 'quarter', 'half', 'year'] as const) by[p][ik[p]] = add(by[p][ik[p]], i);
    byKind[i.kind] = add(byKind[i.kind], i);
    byInference[i.inference] = add(byInference[i.inference], i);
    for (const [model, u] of Object.entries(i.models)) {
      const m = (byModel[model] ??= { served: new Set(), calls: 0, usd: 0 });
      if (u.served) m.served.add(u.served);
      m.calls += u.calls ?? 0;
      m.usd = round(m.usd + priceOf(model, u));
    }
  }
  const list = (o: Record<string, Bucket>) => Object.entries(o).sort(([a], [b]) => b.localeCompare(a)).map(([period, b]) => ({ period, ...b }));
  const budget = Number(process.env.CREDIT_BUDGET_USD);
  return {
    generated_at: now.toISOString(),
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    endpoint: modelEndpoint(),
    estimate: true,
    pricing_per_million_tokens: PRICING,
    budget_usd: Number.isFinite(budget) && budget > 0 ? budget : null,
    remaining_usd: Number.isFinite(budget) && budget > 0 ? round(budget - periods.all.usd) : null,
    periods,
    by_month: list(by.month),
    by_quarter: list(by.quarter),
    by_half: list(by.half),
    by_year: list(by.year),
    by_kind: byKind,
    by_inference: byInference,
    by_model: Object.entries(byModel).map(([model, m]) => ({ model, served: [...m.served], calls: m.calls, usd: m.usd })).sort((a, b) => b.usd - a.usd),
    recent: items.slice(0, 12),
    excluded: { synthetic_runs: synthetic },
  };
}
