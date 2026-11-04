import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from './paths.ts';

// Access codes for the hosted demo. A code is a signed claim (HMAC-SHA256 with a server-only
// secret): who it is for, its role, when it expires and how many live investigations it may
// start. Nothing is stored server-side except per-holder usage counts.

export type AccessRole = 'judge' | 'admin';

export interface AccessClaims {
  sub: string;
  role: AccessRole;
  exp: number;
  runs: number;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export const accessSecret = () => process.env.ACCESS_SECRET ?? '';
export const gated = () => accessSecret().length > 0;

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function mintToken(claims: AccessClaims, secret = accessSecret()): string {
  if (secret.length < 32) throw new Error('ACCESS_SECRET must be at least 32 characters');
  const payload = b64(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyToken(token: string | undefined | null, secret = accessSecret(), now = Date.now()): AccessClaims | null {
  if (!token || !secret) return null;
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AccessClaims;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
    if (claims.role !== 'judge' && claims.role !== 'admin') return null;
    return claims;
  } catch {
    return null;
  }
}

const usageFile = () => path.join(dataDir(), 'access-usage.json');
let usage: Record<string, { runs: number; last: string }> | null = null;

async function loadUsage() {
  usage ??= JSON.parse(await readFile(usageFile(), 'utf8').catch(() => '{}'));
  return usage!;
}

export async function runsLeft(c: AccessClaims): Promise<number> {
  return Math.max(0, c.runs - ((await loadUsage())[c.sub]?.runs ?? 0));
}

export async function chargeRun(c: AccessClaims): Promise<void> {
  const u = await loadUsage();
  u[c.sub] = { runs: (u[c.sub]?.runs ?? 0) + 1, last: new Date().toISOString() };
  await mkdir(path.dirname(usageFile()), { recursive: true });
  await writeFile(usageFile(), JSON.stringify(u, null, 2));
}

// Fixed-window limiter for failed logins, per client address.
const failures = new Map<string, { count: number; window: number }>();
export function loginBlocked(ip: string, limit = 10): boolean {
  const w = Math.floor(Date.now() / 60_000);
  const f = failures.get(ip);
  return !!f && f.window === w && f.count >= limit;
}
export function recordLoginFailure(ip: string) {
  const w = Math.floor(Date.now() / 60_000);
  const f = failures.get(ip);
  failures.set(ip, f && f.window === w ? { count: f.count + 1, window: w } : { count: 1, window: w });
}
