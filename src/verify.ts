import { readArtifact } from './incidents.ts';

// Checks every claim the model makes against the files it claims to have read.
// A quote is only "verified" if it really occurs at (or within a few lines of) the cited range.

export type EvidenceStatus = 'verified' | 'misplaced' | 'not_found' | 'missing_artifact';

export interface EvidenceCheck {
  status: EvidenceStatus;
  // Where the quote was actually found (1-based), when it was found at all.
  found_line?: number;
}

export interface Evidence {
  artifact: string;
  start_line: number;
  end_line: number;
  quote: string;
}

const LINE_SLACK = 3;

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Models sometimes echo the "12| " prefix from read_artifact, or elide with "...".
function quoteFragments(quote: string): string[] {
  const unprefixed = quote
    .split('\n')
    .map((l) => l.replace(/^\s*\d+\|\s?/, ''))
    .join('\n');
  return unprefixed
    .split(/\.\.\.|…/)
    .map(norm)
    .filter((f) => f.length >= 6);
}

// Joins lines into one normalised string, remembering which line each offset came from.
function index(lines: string[]) {
  let text = '';
  const starts: number[] = [];
  for (const l of lines) {
    starts.push(text.length);
    text += norm(l) + ' ';
  }
  const lineAt = (offset: number) => {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > offset) i--;
    return i + 1;
  };
  return { text, lineAt };
}

// Returns the 1-based line where all fragments occur in order, or undefined.
function locate(lines: string[], fragments: string[], firstLine = 1): number | undefined {
  if (!fragments.length) return undefined;
  const { text, lineAt } = index(lines);
  let from = 0;
  let first: number | undefined;
  for (const f of fragments) {
    const at = text.indexOf(f, from);
    if (at < 0) return undefined;
    first ??= at;
    from = at + f.length;
  }
  return lineAt(first!) + firstLine - 1;
}

export async function verifyEvidence(incidentId: string, ev: Evidence): Promise<EvidenceCheck> {
  let lines: string[];
  try {
    lines = await readArtifact(incidentId, ev.artifact);
  } catch {
    return { status: 'missing_artifact' };
  }
  const fragments = quoteFragments(ev.quote);
  const start = Math.max(1, Math.min(ev.start_line, ev.end_line) - LINE_SLACK);
  const end = Math.min(lines.length, Math.max(ev.start_line, ev.end_line) + LINE_SLACK);
  const inRange = locate(lines.slice(start - 1, end), fragments, start);
  if (inRange !== undefined) return { status: 'verified', found_line: inRange };
  const anywhere = locate(lines, fragments);
  if (anywhere !== undefined) return { status: 'misplaced', found_line: anywhere };
  return { status: 'not_found' };
}

export interface PatchCheck {
  status: 'applies' | 'mismatch' | 'no_removals' | 'missing_artifact';
  checked: number;
  missing: string[];
}

// A patch is plausible only if the lines it removes and the context it quotes exist in the target.
export async function verifyPatch(incidentId: string, fix: { artifact: string; patch: string }): Promise<PatchCheck> {
  let lines: string[];
  try {
    lines = await readArtifact(incidentId, fix.artifact);
  } catch {
    return { status: 'missing_artifact', checked: 0, missing: [] };
  }
  const present = new Set(lines.map((l) => l.trim()));
  const patchLines = String(fix.patch).replace(/\r\n/g, '\n').split('\n');
  const removed = patchLines.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1).trim());
  const context = patchLines.filter((l) => l.startsWith(' ')).map((l) => l.slice(1).trim());
  const toCheck = [...removed, ...context].filter((l) => l.length > 0);
  const missing = toCheck.filter((l) => !present.has(l));
  if (!removed.some((l) => l.length > 0)) return { status: 'no_removals', checked: toCheck.length, missing };
  return { status: missing.length ? 'mismatch' : 'applies', checked: toCheck.length, missing };
}
