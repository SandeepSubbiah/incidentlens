import { readArtifact } from './incidents.ts';
import { lineDiff } from './skills/registry.ts';

// Applies a model-written unified diff to an isolated in-memory copy of an artifact. The
// evidence on disk is never written. Context and removed lines must match in order (ignoring
// surrounding whitespace); added lines are taken as written.

export type ApplyResult = { ok: true; lines: string[] } | { ok: false; reason: string };

export function applyUnifiedPatch(original: string[], patch: string): ApplyResult {
  const body = String(patch).replace(/\r\n/g, '\n').split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++') && !l.startsWith('diff ') && !l.startsWith('index '));
  const hunks: string[][] = [];
  let current: string[] = [];
  for (const l of body) {
    if (l.startsWith('@@')) {
      if (current.length) hunks.push(current);
      current = [];
    } else current.push(l);
  }
  if (current.length) hunks.push(current);

  const out = [...original];
  let cursor = 0;
  for (const [i, hunk] of hunks.entries()) {
    while (hunk.length && hunk.at(-1)!.trim() === '') hunk.pop();
    if (!hunk.length) continue;
    // Lines without a diff prefix are treated as context, as models often drop the leading space.
    const ops = hunk.map((l) => (l[0] === '+' || l[0] === '-' || l[0] === ' ' ? { op: l[0], text: l.slice(1) } : { op: ' ', text: l }));
    const old = ops.filter((o) => o.op !== '+');
    if (!old.length) return { ok: false, reason: `hunk ${i + 1} has no context or removed lines to anchor it` };
    let at = -1;
    for (let s = cursor; s + old.length <= out.length && at < 0; s++) {
      if (old.every((o, k) => out[s + k].trim() === o.text.trim())) at = s;
    }
    if (at < 0) return { ok: false, reason: `hunk ${i + 1} does not match the artifact (first line: ${JSON.stringify(old[0].text.trim().slice(0, 80))})` };
    const replacement: string[] = [];
    let k = 0;
    for (const o of ops) {
      if (o.op === '+') replacement.push(o.text);
      else {
        if (o.op === ' ') replacement.push(out[at + k]); // keep the artifact's exact indentation
        k++;
      }
    }
    out.splice(at, old.length, ...replacement);
    cursor = at + replacement.length;
  }
  return { ok: true, lines: out };
}

export interface SandboxResult {
  status: 'applied' | 'failed';
  reason?: string;
  changed_lines?: number;
  diff?: string;
}

export async function sandboxApply(caseId: string, fix: { artifact: string; patch: string }): Promise<SandboxResult> {
  let original: string[];
  try {
    original = await readArtifact(caseId, fix.artifact);
  } catch {
    return { status: 'failed', reason: `artifact ${fix.artifact} does not exist` };
  }
  const r = applyUnifiedPatch(original, fix.patch);
  if (!r.ok) return { status: 'failed', reason: r.reason };
  const diff = lineDiff(original.join('\n'), r.lines.join('\n'))
    .split('\n')
    .filter((l) => l[0] !== ' ')
    .join('\n');
  if (!diff.trim()) return { status: 'failed', reason: 'patch applied but changed nothing' };
  return { status: 'applied', changed_lines: diff.split('\n').length, diff };
}
