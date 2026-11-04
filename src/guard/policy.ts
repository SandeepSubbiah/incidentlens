// Deterministic gate for changes to the system's own skills. It runs in code, outside the model,
// so no prompt, skill or self-repair proposal can talk its way past it.

export interface Violation {
  rule: string;
  detail: string;
}

export interface PatchInput {
  name: string;
  kind: string;
  content: string;
  previous: string;
  author: string;
}

const MAX_CHARS = 12_000;
const MAX_CHANGE_RATIO = 0.5;

const SECRET_PATTERNS: [string, RegExp][] = [
  ['api key (sk-)', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['aws access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['bearer credential', /\bbearer\s+[A-Za-z0-9._-]{20,}/i],
];

// Checked against lines the patch adds, so long-standing human-written text is not re-litigated.
const DIRECTIVE_PATTERNS: [string, RegExp][] = [
  ['overrides core rules', /\b(ignore|override|bypass|disable|disregard|skip|weaken|relax)\b[^.\n]{0,40}\b(constitution|verif\w*|citations?|polic(y|ies)|guard\w*|safety|audit|previous instructions|rules)\b/i],
  ['removes evidence discipline', /\b(without|no need (for|to)|don'?t|do not|never|skip)\b[^.\n]{0,30}\b(cit(e|es|ing|ation|ations)|evidence|verify|verification|quotes?)\b/i],
  ['secret disclosure', /\b(reveal|print|output|show|send|leak|include|repeat)\b[^.\n]{0,40}\b(api[ _-]?keys?|secrets?|tokens?|passwords?|credentials?|system prompt)\b/i],
  ['network exfiltration', /\b(curl|wget|fetch|post|upload|send|exfiltrat\w*)\b[^.\n]{0,40}https?:\/\//i],
  ['self-modification beyond skills', /\b(edit|modify|change|rewrite|delete|replace)\b[^.\n]{0,40}\b(constitution|verifier|policy guard|tools?|source code|answer keys?|ground[- ]truth|scor(e|ing)|audit log)\b/i],
];

function lines(s: string): string[] {
  return s.replace(/\r\n/g, '\n').split('\n');
}

export function addedLines(previous: string, next: string): string[] {
  const before = new Set(lines(previous).map((l) => l.trim()));
  return lines(next).map((l) => l.trim()).filter((l) => l && !before.has(l));
}

function changeRatio(previous: string, next: string): number {
  const a = lines(previous).map((l) => l.trim());
  const b = lines(next).map((l) => l.trim());
  const setA = new Set(a);
  const setB = new Set(b);
  const changed = b.filter((l) => !setA.has(l)).length + a.filter((l) => !setB.has(l)).length;
  return changed / Math.max(a.length, b.length, 1);
}

function knownSecrets(): string[] {
  return [process.env.MODEL_API_KEY, process.env.ACCESS_SECRET].filter((s): s is string => !!s && s.length >= 8);
}

export function findSecrets(text: string): Violation[] {
  const found: Violation[] = SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([rule]) => ({ rule: 'secret', detail: rule }));
  if (knownSecrets().some((s) => text.includes(s))) found.push({ rule: 'secret', detail: 'contains a configured credential' });
  return found;
}

const isAiAuthor = (author: string) => !(author === 'repo' || author.startsWith('human:') || author.startsWith('chaos:'));

export function checkSkillPatch(p: PatchInput): { ok: boolean; violations: Violation[]; added: string[] } {
  const violations: Violation[] = [];
  const added = addedLines(p.previous, p.content);

  if (p.kind !== 'role' && p.kind !== 'runbook') violations.push({ rule: 'namespace', detail: `only role and runbook skills can change, not ${p.kind}` });
  const fm = p.content.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  const name = fm?.[1].match(/^name:\s*(.+)$/m)?.[1].trim();
  const kind = fm?.[1].match(/^kind:\s*(.+)$/m)?.[1].trim();
  if (name !== p.name || kind !== p.kind) violations.push({ rule: 'frontmatter', detail: `frontmatter must keep name: ${p.name} and kind: ${p.kind}` });
  if (p.content.length > MAX_CHARS) violations.push({ rule: 'size', detail: `${p.content.length} chars exceeds ${MAX_CHARS}` });
  violations.push(...findSecrets(p.content));

  // Human edits are trusted but still may not store secrets; AI proposals get the full gate.
  if (isAiAuthor(p.author)) {
    for (const line of added) {
      for (const [rule, re] of DIRECTIVE_PATTERNS) if (re.test(line)) violations.push({ rule, detail: line.slice(0, 160) });
      const prevUrls = new Set(p.previous.match(/https?:\/\/\S+/g) ?? []);
      for (const url of line.match(/https?:\/\/\S+/g) ?? []) if (!prevUrls.has(url)) violations.push({ rule: 'new external url', detail: url });
    }
    const ratio = changeRatio(p.previous, p.content);
    if (ratio > MAX_CHANGE_RATIO) violations.push({ rule: 'minimal change', detail: `${Math.round(ratio * 100)}% of lines changed; self-repairs must change at most ${MAX_CHANGE_RATIO * 100}%` });
  }
  return { ok: violations.length === 0, violations, added };
}
