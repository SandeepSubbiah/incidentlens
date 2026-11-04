import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chargeRun, gated, loginBlocked, recordLoginFailure, runsLeft, verifyToken, type AccessClaims } from './access.ts';
import { investigate, RUNS_DIR } from './agent.ts';
import { activeFaults, clearFaults, setOutage } from './chaos.ts';
import { constitutionStatus } from './guard/constitution.ts';
import { injectBadSkillEdit, runDoctor } from './heal/doctor.ts';
import { health } from './heal/health.ts';
import { listArtifacts, listIncidents, readArtifact } from './incidents.ts';
import { MODELS, reflexState, WIRE } from './llm.ts';
import { getRegistry, lineDiff } from './skills/registry.ts';
import { runWarRoom, TIERS } from './warroom/run.ts';

const PORT = Number(process.env.PORT ?? 5173);
const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', 'public');
const EVAL_DIR = path.resolve(import.meta.dirname, '..', 'eval');
const MAX_LIVE_RUNS = Number(process.env.MAX_CONCURRENT_RUNS ?? 2);
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

let liveRuns = 0;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

function sse(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...SECURITY_HEADERS });
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  return {
    send: (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`),
    end: () => {
      clearInterval(ping);
      res.write('event: done\ndata: {}\n\n');
      res.end();
    },
  };
}

function tokenFrom(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return /(?:^|;\s*)il_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
}

async function body(req: IncomingMessage, limit = 16_384): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error('request body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

async function latestRun(id: string, mode: string): Promise<any | null> {
  const dir = path.join(RUNS_DIR, id);
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort().reverse();
  for (const f of files) {
    const run = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    const start = run.events.find((e: any) => e.type === 'start');
    if ((start?.mode ?? 'solo') === mode && run.events.some((e: any) => e.type === 'report')) return { file: f, ...run };
  }
  return null;
}

export function createApp(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const ip = req.socket.remoteAddress ?? 'unknown';
    try {
      if (parts[0] !== 'api') {
        const rel = url.pathname === '/' ? 'index.html' : path.posix.normalize(url.pathname).replace(/^\/+/, '');
        const file = path.resolve(PUBLIC_DIR, rel);
        if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'forbidden' });
        const content = await readFile(file).catch(() => null);
        if (!content) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', ...SECURITY_HEADERS });
        return res.end(content);
      }

      // Access: open when no ACCESS_SECRET is configured (local use); otherwise live work needs a code.
      const claims: AccessClaims | null = gated() ? verifyToken(tokenFrom(req)) : { sub: 'local', role: 'admin', exp: Infinity, runs: Infinity };
      const requireRole = (role: 'judge' | 'admin') => {
        if (!claims) return json(res, 401, { error: 'access code required' }), false;
        if (role === 'admin' && claims.role !== 'admin') return json(res, 403, { error: 'admin access required' }), false;
        return true;
      };
      const route = parts.slice(1).join('/');

      if (route === 'session' && req.method === 'POST') {
        if (loginBlocked(ip)) return json(res, 429, { error: 'too many attempts; wait a minute' });
        const { code } = await body(req);
        const c = verifyToken(String(code ?? ''));
        if (!c) {
          recordLoginFailure(ip);
          return json(res, 401, { error: 'invalid or expired access code' });
        }
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        const maxAge = Math.max(0, Math.floor(c.exp - Date.now() / 1000));
        return json(res, 200, { sub: c.sub, role: c.role, runs_left: await runsLeft(c) }, { 'set-cookie': `il_session=${code}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}` });
      }
      if (route === 'session') {
        return json(res, 200, claims ? { sub: claims.sub, role: claims.role, runs_left: gated() ? await runsLeft(claims) : null, gated: gated() } : { gated: true, sub: null });
      }
      if (route === 'config') {
        return json(res, 200, { model: MODELS.deep, models: MODELS, tiers: TIERS, wire: WIRE, key: Boolean(process.env.MODEL_API_KEY), gated: gated(), constitution: { ok: constitutionStatus().ok, sha256: constitutionStatus().sha256 } });
      }
      if (route === 'incidents') return json(res, 200, await listIncidents());
      if (parts[1] === 'incidents' && parts[3] === 'artifacts') return json(res, 200, await listArtifacts(parts[2]));
      if (parts[1] === 'incidents' && parts[3] === 'artifact') return json(res, 200, { path: url.searchParams.get('path'), lines: await readArtifact(parts[2], url.searchParams.get('path') ?? '') });
      if (parts[1] === 'runs' && parts[2]) {
        const run = await latestRun(parts[2], url.searchParams.get('mode') === 'warroom' ? 'warroom' : 'solo');
        return run ? json(res, 200, run) : json(res, 404, { error: 'no recorded run' });
      }
      if (route === 'eval') {
        const file = url.searchParams.get('mode') === 'warroom' ? 'latest-warroom.json' : 'latest.json';
        const raw = await readFile(path.join(EVAL_DIR, file), 'utf8').catch(() => null);
        return raw ? json(res, 200, JSON.parse(raw)) : json(res, 404, { error: 'no eval run yet' });
      }
      if (route === 'health') {
        const reg = await getRegistry();
        return json(res, 200, { ...(await health()), reflexes: reflexState(), faults: activeFaults(), constitution: { ok: constitutionStatus().ok }, audit: await reg.audit.verify(), revision: reg.revision });
      }
      if (route === 'skills') return json(res, 200, (await getRegistry()).list());
      if (parts[1] === 'skills' && parts[2]) {
        const reg = await getRegistry();
        const v = Number(url.searchParams.get('v')) || undefined;
        const against = Number(url.searchParams.get('diff')) || undefined;
        return json(res, 200, { name: parts[2], content: reg.content(parts[2], v), diff: against ? lineDiff(reg.content(parts[2], against), reg.content(parts[2], v)) : null });
      }
      if (route === 'audit') {
        const reg = await getRegistry();
        return json(res, 200, { verify: await reg.audit.verify(), entries: (await reg.audit.entries()).slice(-50).reverse() });
      }

      if (parts[1] === 'investigate' && parts[2]) {
        if (!requireRole('judge')) return;
        if (gated() && (await runsLeft(claims!)) <= 0) return json(res, 429, { error: 'this access code has no live investigations left' });
        if (liveRuns >= MAX_LIVE_RUNS) return json(res, 429, { error: 'the server is busy with other investigations; try again shortly' });
        await listArtifacts(parts[2]); // 404s an unknown incident before any spend
        liveRuns++;
        if (gated()) await chargeRun(claims!);
        const stream = sse(res);
        try {
          const run = url.searchParams.get('mode') === 'warroom' ? runWarRoom : investigate;
          await run(parts[2], stream.send);
        } finally {
          liveRuns--;
          stream.end();
        }
        return;
      }
      if (route === 'heal/run') {
        if (!requireRole('admin')) return;
        const stream = sse(res);
        await runDoctor(stream.send, { force: url.searchParams.get('force') === '1' }).finally(stream.end);
        return;
      }
      if (route === 'chaos' && req.method === 'POST') {
        if (!requireRole('admin')) return;
        const { fault, model, seconds } = await body(req);
        if (fault === 'outage') {
          const target = model === 'fast' ? MODELS.fast : MODELS.deep;
          setOutage(target, Math.min(Number(seconds) || 120, 900));
          return json(res, 200, { ok: true, faults: activeFaults() });
        }
        if (fault === 'bad-skill') return json(res, 200, { ok: true, ...(await injectBadSkillEdit()) });
        if (fault === 'clear') {
          clearFaults();
          return json(res, 200, { ok: true, faults: [] });
        }
        return json(res, 400, { error: 'fault must be outage, bad-skill or clear' });
      }
      return json(res, 404, { error: 'not found' });
    } catch (err: any) {
      const status = /no such artifact|invalid incident id|ENOENT/.test(err.message) ? 404 : 400;
      if (!res.headersSent) json(res, status, { error: err.message });
      else res.end();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createApp().listen(PORT, () => {
    console.log(`IncidentLens on http://localhost:${PORT}  (deep ${MODELS.deep}, fast ${MODELS.fast}, ${WIRE} API${process.env.MODEL_API_KEY ? '' : ', MODEL_API_KEY NOT SET'}${gated() ? ', access codes required' : ', open access'})`);
  });
}
