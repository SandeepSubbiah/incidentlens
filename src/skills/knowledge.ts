import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from '../paths.ts';
import type { RegistryView } from './registry.ts';

// Retrieval over runbook skills and past investigations. Meta Model API has no embeddings
// endpoint, so this is BM25 lexical retrieval: deterministic, dependency-free and testable.

export interface CaseCard {
  incident_id: string;
  title: string;
  service: string;
  summary: string;
  root_cause: string;
  category: string;
  at: string;
}

export interface Hit {
  id: string;
  kind: 'runbook' | 'case';
  source: string;
  section: string;
  version?: number;
  incident?: string;
  score: number;
  text: string;
}

interface Doc extends Omit<Hit, 'score'> {
  tokens: string[];
}

const STOP = new Set(
  'a an and are as at be but by can do does for from has have how if in into is it its no not of on or so such that the their then there these they this to was were what when where which while who why will with you your'.split(' '),
);

function stem(t: string): string {
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

const K1 = 1.2;
const B = 0.75;

export class Knowledge {
  private docs: Doc[];
  private df = new Map<string, number>();
  private avgdl: number;

  constructor(docs: Doc[]) {
    this.docs = docs;
    for (const d of docs) for (const t of new Set(d.tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgdl = docs.reduce((n, d) => n + d.tokens.length, 0) / Math.max(docs.length, 1);
  }

  get size() {
    return this.docs.length;
  }

  // Past cases from the incident under investigation are excluded: an investigation must never
  // retrieve its own earlier answer.
  search(query: string, opts: { k?: number; excludeIncident?: string } = {}): Hit[] {
    const q = [...new Set(tokenize(query))];
    const N = this.docs.length;
    const scored: Hit[] = [];
    for (const d of this.docs) {
      if (opts.excludeIncident && d.incident === opts.excludeIncident) continue;
      let score = 0;
      for (const t of q) {
        const tf = d.tokens.filter((x) => x === t).length;
        if (!tf) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.tokens.length) / this.avgdl));
      }
      if (score > 0) {
        const { tokens, ...hit } = d;
        scored.push({ ...hit, score: Math.round(score * 100) / 100 });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, opts.k ?? 4);
  }
}

export function buildKnowledge(view: RegistryView, cases: CaseCard[] = []): Knowledge {
  const docs: Doc[] = [];
  for (const s of view.all().filter((x) => x.kind === 'runbook')) {
    // Name, description and tags are repeated in every chunk so section text inherits the topic.
    const topic = `${s.name.replace(/-/g, ' ')} ${s.description} ${s.tags.join(' ')}`;
    for (const part of s.body.split(/^## /m).slice(1)) {
      const [heading, ...rest] = part.split('\n');
      const text = rest.join('\n').trim();
      docs.push({
        id: `${s.name}#${heading.trim().toLowerCase().replace(/\s+/g, '-')}`,
        kind: 'runbook',
        source: s.name,
        section: heading.trim(),
        version: s.version,
        text,
        tokens: tokenize(`${topic} ${topic} ${heading} ${text}`),
      });
    }
  }
  for (const c of cases) {
    const text = `${c.summary}\nRoot cause: ${c.root_cause}`;
    docs.push({
      id: `case:${c.incident_id}:${c.at}`,
      kind: 'case',
      source: c.title,
      section: `${c.service} (${c.category})`,
      incident: c.incident_id,
      text,
      tokens: tokenize(`${c.title} ${c.service} ${text}`),
    });
  }
  return new Knowledge(docs);
}

export function formatHits(hits: Hit[]): string {
  if (!hits.length) return 'No matching runbooks or past cases.';
  return [
    'Guidance only: runbooks and past cases are not evidence about this incident. Do not cite them.',
    ...hits.map((h) =>
      h.kind === 'runbook'
        ? `\n[runbook ${h.source} v${h.version} · ${h.section}]\n${h.text.slice(0, 1400)}`
        : `\n[past case: ${h.source} · ${h.section}]\n${h.text.slice(0, 800)}`,
    ),
  ].join('\n');
}

const casesDir = () => path.join(dataDir(), 'cases');

export async function saveCase(card: CaseCard): Promise<void> {
  await mkdir(casesDir(), { recursive: true });
  await writeFile(path.join(casesDir(), `${card.incident_id}-${card.at.replace(/[:.]/g, '-')}.json`), JSON.stringify(card, null, 2));
}

export async function loadCases(): Promise<CaseCard[]> {
  const files = (await readdir(casesDir()).catch(() => [] as string[])).filter((f) => f.endsWith('.json'));
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(casesDir(), f), 'utf8'))));
}
