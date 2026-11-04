import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../paths.ts';

export const CONSTITUTION_PATH = path.join(ROOT, 'core', 'constitution.md');

// Changing the constitution requires changing this pin in a reviewed code change. Nothing the
// running system can write (skills, registry, data/) can move it.
export const PINNED_SHA256 = '36517e6bdbd12a3d618c487e4e8b111970050dff48bd11950c3a0b7a4c49c7ed';

export interface ConstitutionStatus {
  ok: boolean;
  sha256: string;
  expected: string;
  text: string;
}

export function constitutionStatus(file = CONSTITUTION_PATH): ConstitutionStatus {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const sha256 = createHash('sha256').update(text).digest('hex');
  return { ok: sha256 === PINNED_SHA256, sha256, expected: PINNED_SHA256, text };
}

export class ConstitutionTamperedError extends Error {
  constructor(status: ConstitutionStatus) {
    super(`constitution integrity check failed: sha256 ${status.sha256.slice(0, 12)} does not match pinned ${status.expected.slice(0, 12)}`);
  }
}

// Read on every run (not cached), so an on-disk edit is caught by the next investigation.
export function loadConstitution(file = CONSTITUTION_PATH): string {
  const status = constitutionStatus(file);
  if (!status.ok) throw new ConstitutionTamperedError(status);
  return status.text;
}
