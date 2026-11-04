import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const INCIDENTS_DIR = path.resolve(import.meta.dirname, '..', 'incidents');

// Files at an incident's root that the agent must never see: metadata is given to it
// separately, and the ground truth is the answer key used only for scoring.
const HIDDEN = new Set(['incident.json', 'ground-truth.json']);

export interface IncidentMeta {
  id: string;
  title: string;
  service: string;
  severity: string;
  started_at: string;
  alert: string;
}

export interface GroundTruth {
  root_cause: string;
  must_mention: string[][];
  fix_artifact: string;
}

export interface Artifact {
  path: string;
  lines: number;
  bytes: number;
}

function incidentRoot(id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid incident id: ${id}`);
  return path.join(INCIDENTS_DIR, id);
}

export async function listIncidents(): Promise<IncidentMeta[]> {
  const dirs = await readdir(INCIDENTS_DIR, { withFileTypes: true });
  const metas = await Promise.all(
    dirs.filter((d) => d.isDirectory()).map((d) => loadMeta(d.name)),
  );
  return metas.sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadMeta(id: string): Promise<IncidentMeta> {
  return JSON.parse(await readFile(path.join(incidentRoot(id), 'incident.json'), 'utf8'));
}

export async function loadGroundTruth(id: string): Promise<GroundTruth> {
  return JSON.parse(await readFile(path.join(incidentRoot(id), 'ground-truth.json'), 'utf8'));
}

export async function listArtifacts(id: string): Promise<Artifact[]> {
  const root = incidentRoot(id);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const out: Artifact[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const rel = path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join('/');
    if (HIDDEN.has(rel)) continue;
    const text = await readFile(path.join(root, rel), 'utf8');
    out.push({ path: rel, lines: splitLines(text).length, bytes: Buffer.byteLength(text) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// Resolves an agent-supplied path, refusing anything outside the incident or hidden.
export function resolveArtifact(id: string, rel: string): string {
  const root = incidentRoot(id);
  const normalized = path.posix.normalize(String(rel).replace(/\\/g, '/')).replace(/^\.\/|^\/+/, '');
  const abs = path.resolve(root, normalized);
  if (!abs.startsWith(root + path.sep)) throw new Error(`path outside incident: ${rel}`);
  if (HIDDEN.has(normalized)) throw new Error(`no such artifact: ${rel}`);
  return abs;
}

export async function readArtifact(id: string, rel: string): Promise<string[]> {
  try {
    return splitLines(await readFile(resolveArtifact(id, rel), 'utf8'));
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') throw new Error(`no such artifact: ${rel}`);
    throw err;
  }
}

export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
