import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Append-only, hash-chained log of every change to the system's own behaviour. Each entry's
// hash covers its content and the previous entry's hash, so editing or deleting any past
// entry breaks every hash after it.

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  prev: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

function digest(e: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify([e.seq, e.at, e.actor, e.action, e.target, e.detail, e.prev])).digest('hex');
}

export class AuditLog {
  readonly file: string;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  async entries(): Promise<AuditEntry[]> {
    const raw = await readFile(this.file, 'utf8').catch(() => '');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  append(actor: string, action: string, target: string, detail: Record<string, unknown> = {}): Promise<AuditEntry> {
    const next = this.tail.then(async () => {
      const all = await this.entries();
      const last = all.at(-1);
      const base = { seq: (last?.seq ?? 0) + 1, at: new Date().toISOString(), actor, action, target, detail, prev: last?.hash ?? GENESIS };
      const entry: AuditEntry = { ...base, hash: digest(base) };
      await mkdir(path.dirname(this.file), { recursive: true });
      await appendFile(this.file, JSON.stringify(entry) + '\n');
      return entry;
    });
    this.tail = next.catch(() => {});
    return next;
  }

  async verify(): Promise<{ ok: boolean; length: number; broken_at?: number }> {
    await this.tail;
    const all = await this.entries();
    let prev = GENESIS;
    for (const e of all) {
      const { hash, ...base } = e;
      if (e.prev !== prev || digest(base) !== hash) return { ok: false, length: all.length, broken_at: e.seq };
      prev = hash;
    }
    return { ok: true, length: all.length };
  }
}

// One writer per file: two AuditLog instances appending to the same file would race and fork
// the chain.
const logs = new Map<string, AuditLog>();
export function auditLogAt(file: string): AuditLog {
  let log = logs.get(file);
  if (!log) logs.set(file, (log = new AuditLog(file)));
  return log;
}
