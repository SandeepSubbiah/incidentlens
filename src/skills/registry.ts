import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AuditLog } from '../guard/audit.ts';
import { constitutionStatus } from '../guard/constitution.ts';
import { checkSkillPatch, type Violation } from '../guard/policy.ts';
import { dataDir, ROOT } from '../paths.ts';

// Versioned store for role and runbook skills. Every investigation takes an immutable view at
// start, so activating a new version changes behaviour on the next run with no restart, and a
// rollback is a pointer move. Seeds come from skills/ in the repository.

export type SkillKind = 'role' | 'runbook';

export interface SkillVersion {
  v: number;
  sha256: string;
  author: string;
  reason: string;
  at: string;
  content: string;
}

interface SkillRecord {
  name: string;
  kind: SkillKind;
  active: number;
  versions: SkillVersion[];
  activations: { v: number; at: string; author: string; reason: string }[];
}

interface State {
  revision: number;
  skills: Record<string, SkillRecord>;
}

export interface Skill {
  name: string;
  kind: SkillKind;
  description: string;
  tags: string[];
  // -1 marks an uncommitted candidate supplied as an overlay during validation.
  version: number;
  content: string;
  body: string;
}

export interface RegistryView {
  revision: number;
  overridden: string[];
  get(name: string): Skill | undefined;
  all(): Skill[];
  versions(): Record<string, number>;
}

export class SkillPolicyError extends Error {
  violations: Violation[];
  constructor(violations: Violation[]) {
    super(`skill change rejected by policy: ${violations.map((v) => `${v.rule} (${v.detail})`).join('; ')}`);
    this.violations = violations;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function parseSkill(content: string): { meta: Record<string, string>; tags: string[]; body: string } {
  const m = content.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, tags: [], body: content };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  const tags = (meta.tags ?? '').replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()).filter(Boolean);
  return { meta, tags, body: m[2] };
}

const isAiAuthor = (author: string) => !(author === 'repo' || author.startsWith('human:') || author.startsWith('chaos:'));

export class Registry {
  readonly audit: AuditLog;
  readonly dir: string;
  readonly seedDir: string;
  private state: State = { revision: 0, skills: {} };
  private readonly file: string;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(dir: string, seedDir: string) {
    this.dir = dir;
    this.seedDir = seedDir;
    this.file = path.join(dir, 'registry', 'state.json');
    this.audit = new AuditLog(path.join(dir, 'audit.jsonl'));
  }

  // Mutations are serialised so concurrent requests cannot interleave read-modify-write.
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }

  private async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file + '.tmp', JSON.stringify(this.state, null, 2));
    await rename(this.file + '.tmp', this.file);
  }

  private async seeds(): Promise<{ kind: SkillKind; content: string }[]> {
    const out: { kind: SkillKind; content: string }[] = [];
    for (const f of (await readdir(path.join(this.seedDir, 'roles')).catch(() => [] as string[])).sort()) {
      if (f.endsWith('.md')) out.push({ kind: 'role', content: await readFile(path.join(this.seedDir, 'roles', f), 'utf8') });
    }
    for (const d of await readdir(path.join(this.seedDir, 'runbooks'), { withFileTypes: true }).catch(() => [])) {
      if (d.isDirectory()) out.push({ kind: 'runbook', content: await readFile(path.join(this.seedDir, 'runbooks', d.name, 'SKILL.md'), 'utf8') });
    }
    return out.map((s) => ({ ...s, content: s.content.replace(/\r\n/g, '\n') }));
  }

  async load(): Promise<this> {
    await this.exclusive(async () => {
      const raw = await readFile(this.file, 'utf8').catch(() => null);
      if (raw) this.state = JSON.parse(raw);
      for (const seed of await this.seeds()) {
        const name = parseSkill(seed.content).meta.name;
        if (!name) continue;
        const hash = sha256(seed.content);
        const rec = this.state.skills[name];
        const at = new Date().toISOString();
        if (!rec) {
          this.state.skills[name] = {
            name,
            kind: seed.kind,
            active: 1,
            versions: [{ v: 1, sha256: hash, author: 'repo', reason: 'seed', at, content: seed.content }],
            activations: [{ v: 1, at, author: 'repo', reason: 'seed' }],
          };
        } else if (!rec.versions.some((v) => v.sha256 === hash)) {
          // A human changed the file in the repository: the newest human intent wins.
          const v = rec.versions.length + 1;
          rec.versions.push({ v, sha256: hash, author: 'repo', reason: 'repository update', at, content: seed.content });
          rec.active = v;
          rec.activations.push({ v, at, author: 'repo', reason: 'repository update' });
          this.state.revision++;
        }
      }
      await this.save();
    });
    return this;
  }

  view(overrides: Record<string, string> = {}): RegistryView {
    const skills = new Map<string, Skill>();
    for (const rec of Object.values(this.state.skills)) {
      const candidate = overrides[rec.name];
      const content = candidate ?? rec.versions.find((v) => v.v === rec.active)!.content;
      const { meta, tags, body } = parseSkill(content);
      skills.set(rec.name, { name: rec.name, kind: rec.kind, description: meta.description ?? '', tags, version: candidate ? -1 : rec.active, content, body });
    }
    return {
      revision: this.state.revision,
      overridden: Object.keys(overrides),
      get: (n) => skills.get(n),
      all: () => [...skills.values()],
      versions: () => Object.fromEntries([...skills.values()].map((s) => [s.name, s.version])),
    };
  }

  get revision(): number {
    return this.state.revision;
  }

  private record(name: string): SkillRecord {
    const rec = this.state.skills[name];
    if (!rec) throw new Error(`unknown skill: ${name}`);
    return rec;
  }

  private requireIntegrity(author: string) {
    if (isAiAuthor(author) && !constitutionStatus().ok) {
      throw new SkillPolicyError([{ rule: 'constitution', detail: 'constitution integrity check failed; self-changes are locked' }]);
    }
  }

  // Validates a proposed new version against policy without storing it.
  check(name: string, content: string, author: string) {
    const rec = this.record(name);
    const previous = rec.versions.find((v) => v.v === rec.active)!.content;
    return checkSkillPatch({ name, kind: rec.kind, content: content.replace(/\r\n/g, '\n'), previous, author });
  }

  addVersion(name: string, content: string, author: string, reason: string): Promise<number> {
    return this.exclusive(async () => {
      this.requireIntegrity(author);
      const rec = this.record(name);
      const normalized = content.replace(/\r\n/g, '\n');
      const verdict = this.check(name, normalized, author);
      if (!verdict.ok) {
        await this.audit.append(author, 'skill.version.rejected', name, { reason, violations: verdict.violations });
        throw new SkillPolicyError(verdict.violations);
      }
      const hash = sha256(normalized);
      const existing = rec.versions.find((v) => v.sha256 === hash);
      if (existing) return existing.v;
      const v = rec.versions.length + 1;
      rec.versions.push({ v, sha256: hash, author, reason, at: new Date().toISOString(), content: normalized });
      await this.save();
      await this.audit.append(author, 'skill.version.add', name, { v, sha256: hash, reason });
      return v;
    });
  }

  activate(name: string, v: number, author: string, reason: string): Promise<void> {
    return this.exclusive(async () => {
      this.requireIntegrity(author);
      const rec = this.record(name);
      if (!rec.versions.some((x) => x.v === v)) throw new Error(`${name} has no version ${v}`);
      const from = rec.active;
      rec.active = v;
      rec.activations.push({ v, at: new Date().toISOString(), author, reason });
      this.state.revision++;
      await this.save();
      await this.audit.append(author, 'skill.activate', name, { from, to: v, reason, revision: this.state.revision });
    });
  }

  // Moves the active pointer back to the version that was active before the current one.
  async rollback(name: string, author: string, reason: string): Promise<number> {
    const rec = this.record(name);
    const previous = [...rec.activations].reverse().find((a) => a.v !== rec.active);
    if (!previous) throw new Error(`${name} has no earlier version to roll back to`);
    await this.activate(name, previous.v, author, `rollback: ${reason}`);
    return previous.v;
  }

  list() {
    return Object.values(this.state.skills)
      .map((rec) => ({
        name: rec.name,
        kind: rec.kind,
        active: rec.active,
        description: parseSkill(rec.versions.find((v) => v.v === rec.active)!.content).meta.description ?? '',
        versions: rec.versions.map(({ content, ...meta }) => meta),
        activations: rec.activations,
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }

  content(name: string, v?: number): string {
    const rec = this.record(name);
    return rec.versions.find((x) => x.v === (v ?? rec.active))?.content ?? '';
  }

  // Changes since a time, newest first, for self-diagnosis evidence.
  changesSince(sinceIso: string) {
    const out: { name: string; from: number; to: number; at: string; author: string; reason: string }[] = [];
    for (const rec of Object.values(this.state.skills)) {
      rec.activations.forEach((a, i) => {
        if (i > 0 && a.at >= sinceIso) out.push({ name: rec.name, from: rec.activations[i - 1].v, to: a.v, at: a.at, author: a.author, reason: a.reason });
      });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }
}

export function lineDiff(a: string, b: string): string {
  const x = a.split('\n');
  const y = b.split('\n');
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push(' ' + x[i]);
      i++;
      j++;
    } else if (j < y.length && (i >= x.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push('+' + y[j++]);
    } else {
      out.push('-' + x[i++]);
    }
  }
  return out.join('\n');
}

let shared: Promise<Registry> | null = null;

export function getRegistry(): Promise<Registry> {
  shared ??= new Registry(dataDir(), path.join(ROOT, 'skills')).load();
  return shared;
}
