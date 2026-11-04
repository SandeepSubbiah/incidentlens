// Sentinel smoke pack: deterministic, offline security checks of this repository only.
//
// Every probe runs in temporary directories, against a local scripted model with a synthetic key.
// Nothing here calls Muse, reads MODEL_API_KEY, or contacts any other host. Scenario IDs follow
// the catalog in the Sentinel security assurance prompt (§4); results and findings are explained in
// docs/SECURITY_ASSURANCE_FINDINGS.md. Each scenario has a
// positive control where one makes sense, so a probe that cannot observe anything reports ERROR,
// never PASS.
//
// Usage: npm run sentinel:smoke [-- --out <file.json>]
// Exit code: 0 only when no scenario is FAIL or ERROR.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

type Status = 'PASS' | 'FAIL' | 'ERROR' | 'UNTESTED';
interface Result {
  id: string;
  title: string;
  refs: string[];
  expected: string;
  status: Status;
  observed: string;
  disposition?: string;
}

const ROOT = path.resolve(import.meta.dirname, '..');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'incidentlens-sentinel-'));
process.env.INCIDENTLENS_DATA_DIR = path.join(tmp, 'data');
process.env.INCIDENTLENS_RUNS_DIR = path.join(tmp, 'runs');
process.env.MODEL_API_KEY = 'sentinel-synthetic-key-not-real';
delete process.env.ACCESS_SECRET;
delete process.env.MODEL_DEEP;
delete process.env.MODEL_FAST;

const listen = async (s: Server) => {
  s.listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

// Scripted model: every turn asks for list_artifacts after a short delay, and counts calls. It
// reports its own model name, so provenance probes can compare it with what the record claims.
let modelCalls = 0;
let delayMs = 20;
let script: { name: string; args: any }[] = [];
const fake = createServer(async (req, res) => {
  for await (const _ of req);
  modelCalls++;
  await new Promise((r) => setTimeout(r, delayMs));
  const next = script.shift() ?? { name: 'list_artifacts', args: {} };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ model: 'sentinel-scripted', output: [{ type: 'function_call', call_id: `c${modelCalls}`, name: next.name, arguments: JSON.stringify(next.args) }], usage: { input_tokens: 1, output_tokens: 1 } }));
});
process.env.MODEL_BASE_URL = await listen(fake);

const { createApp } = await import('../src/server.ts');
const { mintToken, verifyToken } = await import('../src/access.ts');
const { verifyEvidence } = await import('../src/verify.ts');
const { scoreReport } = await import('../src/score.ts');
const { loadGroundTruth } = await import('../src/incidents.ts');
const { AuditLog } = await import('../src/guard/audit.ts');
const { Board } = await import('../src/warroom/board.ts');

const app = createApp();
const base = await listen(app);
const INC = 'inc-001-pool-exhaustion';
const SECRET = 'sentinel-synthetic-secret-0123456789abcdef';
const day = () => Math.floor(Date.now() / 1000) + 86400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Reads a response to the end, so a started run finishes before the next probe counts calls.
async function call(p: string, init: RequestInit = {}) {
  const res = await fetch(base + p, init);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}
const site = (s: string) => ({ 'sec-fetch-site': s, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' });

async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
  return cond();
}

const results: Result[] = [];
async function scenario(meta: Omit<Result, 'status' | 'observed'>, run: () => Promise<{ status: Status; observed: string; disposition?: string }>) {
  try {
    results.push({ ...meta, ...(await run()) });
  } catch (err: any) {
    results.push({ ...meta, status: 'ERROR', observed: String(err?.stack ?? err).split('\n').slice(0, 2).join(' ') });
  }
}

// ---------------------------------------------------------------------------------------------
// D: authentication, authorization, request integrity

await scenario(
  { id: 'D10', title: 'A cross-site GET cannot start a billable investigation (local open mode)', refs: ['OWASP A01', 'OWASP LLM10', 'CWE-352'], expected: 'Requests a browser marks cross-site or same-site are refused before any model call' },
  async () => {
    const before = modelCalls;
    const ok = await call(`/api/investigate/${INC}`, { headers: site('same-origin') });
    const control = modelCalls - before;
    if (ok.status !== 200 || control === 0) return { status: 'ERROR', observed: `positive control did not start a run (HTTP ${ok.status}, ${control} model calls)` };
    const mid = modelCalls;
    const cross = await call(`/api/investigate/${INC}`, { headers: site('cross-site') });
    const sameSite = await call(`/api/investigate/${INC}`, { headers: site('same-site') });
    const spent = modelCalls - mid;
    const observed = `same-origin control: HTTP 200, ${control} model calls; cross-site: HTTP ${cross.status}; same-site: HTTP ${sameSite.status}; model calls caused by them: ${spent}`;
    return { status: cross.status === 403 && sameSite.status === 403 && spent === 0 ? 'PASS' : 'FAIL', observed };
  },
);

await scenario(
  { id: 'D10b', title: 'A cross-site GET cannot start self-repair (local open mode)', refs: ['OWASP A01', 'CWE-352'], expected: 'Refused with 403' },
  async () => {
    const ok = await call('/api/heal/run', { headers: site('same-origin') });
    if (ok.status !== 200) return { status: 'ERROR', observed: `positive control: HTTP ${ok.status}` };
    const cross = await call('/api/heal/run', { headers: site('cross-site') });
    return { status: cross.status === 403 ? 'PASS' : 'FAIL', observed: `same-origin control HTTP ${ok.status}; cross-site HTTP ${cross.status}` };
  },
);

process.env.ACCESS_SECRET = SECRET;

await scenario(
  { id: 'D08', title: 'Concurrent requests cannot spend the same last run of an access code', refs: ['OWASP A06', 'CWE-362', 'OWASP LLM10'], expected: 'A code with 1 run starts exactly 1 of 2 simultaneous investigations' },
  async () => {
    const two = mintToken({ sub: 'sentinel-two', role: 'judge', exp: day(), runs: 2 });
    const one = mintToken({ sub: 'sentinel-one', role: 'judge', exp: day(), runs: 1 });
    const fire = (t: string) => Promise.all([0, 1].map(() => call(`/api/investigate/${INC}`, { headers: { authorization: `Bearer ${t}` } })));
    const control = (await fire(two)).filter((r) => r.status === 200).length;
    if (control !== 2) return { status: 'ERROR', observed: `positive control (2 runs) started ${control} of 2` };
    const started = (await fire(one)).filter((r) => r.status === 200).length;
    return { status: started === 1 ? 'PASS' : 'FAIL', observed: `code with 2 runs: 2 of 2 started (control); code with 1 run: ${started} of 2 started` };
  },
);

await scenario(
  { id: 'D05', title: 'A correctly signed code with an invalid payload is rejected', refs: ['OWASP A07', 'CWE-20'], expected: 'Missing or non-numeric runs, or a missing subject, fails verification' },
  async () => {
    const valid = verifyToken(mintToken({ sub: 's', role: 'judge', exp: day(), runs: 3 }));
    if (!valid) return { status: 'ERROR', observed: 'positive control: a valid code did not verify' };
    const bad = [
      { label: 'no runs', claims: { sub: 's', role: 'judge', exp: day() } },
      { label: 'runs "many"', claims: { sub: 's', role: 'judge', exp: day(), runs: 'many' } },
      { label: 'no subject', claims: { role: 'judge', exp: day(), runs: 3 } },
    ];
    const accepted = bad.filter((b) => verifyToken(mintToken(b.claims as any)) !== null).map((b) => b.label);
    return { status: accepted.length ? 'FAIL' : 'PASS', observed: accepted.length ? `accepted: ${accepted.join(', ')}` : `valid code accepted; ${bad.length} malformed payloads rejected` };
  },
);

await scenario(
  { id: 'D13', title: 'A judge code cannot perform admin actions', refs: ['OWASP A01'], expected: 'Fault injection, self-repair and the kill switch return 403 for a judge, 200 for an admin' },
  async () => {
    const judge = mintToken({ sub: 'sentinel-judge', role: 'judge', exp: day(), runs: 1 });
    const admin = mintToken({ sub: 'sentinel-admin', role: 'admin', exp: day(), runs: 1 });
    const post = (p: string, t: string, b: unknown) => call(p, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const control = await post('/api/chaos', admin, { fault: 'clear' });
    if (control.status !== 200) return { status: 'ERROR', observed: `admin control HTTP ${control.status}` };
    const tries = [
      ['chaos', (await post('/api/chaos', judge, { fault: 'seed-regression' })).status],
      ['kill switch', (await post('/api/governance/kill', judge, { on: true, reason: 'sentinel' })).status],
      ['self-repair', (await call('/api/heal/run', { headers: { authorization: `Bearer ${judge}` } })).status],
    ] as const;
    const allowed = tries.filter(([, s]) => s !== 403);
    return { status: allowed.length ? 'FAIL' : 'PASS', observed: `admin control 200; judge: ${tries.map(([n, s]) => `${n} ${s}`).join(', ')}` };
  },
);

await scenario(
  { id: 'D01', title: 'Read endpoints require a code when access codes are on', refs: ['OWASP A01', 'OWASP API1'], expected: 'Audit log, change requests, skills, runs and evidence return 401 without a code' },
  async () => {
    const paths = ['/api/audit', '/api/changes', '/api/skills/solo', `/api/runs/${INC}?mode=solo`, `/api/incidents/${INC}/artifact?path=logs/payment-service.log`];
    const open = [];
    for (const p of paths) {
      const s = (await call(p)).status;
      if (s !== 401) open.push(`${p.split('?')[0]} ${s}`);
    }
    return { status: open.length ? 'FAIL' : 'PASS', observed: open.length ? `readable without a code: ${open.join('; ')}` : 'all return 401', disposition: open.length ? 'risk accepted for the demo (README: read-only views are public); must change before any customer data' : undefined };
  },
);

delete process.env.ACCESS_SECRET;

// ---------------------------------------------------------------------------------------------
// C, G, A10: containment, headers, error hygiene

await scenario(
  { id: 'C04/C08', title: 'Answer keys and paths outside the case cannot be read through the evidence API', refs: ['OWASP A01', 'CWE-22'], expected: 'ground-truth.json, incident.json and traversal paths are refused; a real log is served' },
  async () => {
    const ok = await call(`/api/incidents/${INC}/artifact?path=logs/payment-service.log`);
    if (ok.status !== 200) return { status: 'ERROR', observed: `positive control HTTP ${ok.status}` };
    const keys = JSON.stringify((await loadGroundTruth(INC)).must_mention).toLowerCase();
    const probes = ['ground-truth.json', 'incident.json', '../inc-002-oomkilled/ground-truth.json', '..%2F..%2Fpackage.json', '/etc/passwd', 'C:\\Windows\\win.ini'];
    const leaked = [];
    for (const p of probes) {
      const r = await call(`/api/incidents/${INC}/artifact?path=${encodeURIComponent(p)}`);
      if (r.status === 200 || r.text.toLowerCase().includes(keys.slice(2, 12))) leaked.push(`${p} -> ${r.status}`);
    }
    return { status: leaked.length ? 'FAIL' : 'PASS', observed: leaked.length ? leaked.join('; ') : `control 200; ${probes.length} probes refused` };
  },
);

await scenario(
  { id: 'G11', title: 'Security headers on pages and API responses', refs: ['OWASP A02', 'OWASP A08'], expected: "CSP with frame-ancestors 'none', nosniff and no-referrer on both" },
  async () => {
    const missing = [];
    for (const p of ['/', '/api/config']) {
      const h = (await call(p)).headers;
      if (!/frame-ancestors 'none'/.test(h.get('content-security-policy') ?? '')) missing.push(`${p} CSP`);
      if (h.get('x-content-type-options') !== 'nosniff') missing.push(`${p} nosniff`);
      if (h.get('referrer-policy') !== 'no-referrer') missing.push(`${p} referrer-policy`);
    }
    return { status: missing.length ? 'FAIL' : 'PASS', observed: missing.length ? `missing: ${missing.join(', ')}` : "present on / and /api/config (note: style-src allows 'unsafe-inline')" };
  },
);

await scenario(
  { id: 'A10', title: 'Error responses do not reveal server file paths', refs: ['OWASP A10', 'CWE-209'], expected: 'No absolute path in any error body' },
  async () => {
    const markers = [ROOT, ROOT.replace(/\\/g, '/'), os.homedir(), tmp].map((m) => m.toLowerCase());
    const leaks = (s: string) => markers.some((m) => s.toLowerCase().includes(m) || s.toLowerCase().includes(JSON.stringify(m).slice(1, -1)));
    if (!leaks(JSON.stringify({ error: `ENOENT: open '${path.join(ROOT, 'x')}'` }))) return { status: 'ERROR', observed: 'detector missed a planted path' };
    const probes: [string, RequestInit][] = [
      [`/api/incidents/${INC}/artifact?path=missing.log`, {}],
      ['/api/incidents/no-such-incident/artifacts', {}],
      [`/api/runs/no-such-incident?mode=solo`, {}],
      ['/api/skills/no-such-skill', {}],
      ['/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' }],
      ['/api/changes/CR-none/decision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"decision":"approve"}' }],
    ];
    const leaked = [];
    for (const [p, init] of probes) {
      const r = await call(p, init);
      if (leaks(r.text)) leaked.push(`${p.split('?')[0]} (${r.status})`);
    }
    return { status: leaked.length ? 'FAIL' : 'PASS', observed: leaked.length ? `path revealed by: ${leaked.join('; ')}` : `${probes.length} error probes, no path revealed (detector checked with a planted path)` };
  },
);

// ---------------------------------------------------------------------------------------------
// F, B09: cancellation and provenance

await scenario(
  { id: 'F05', title: 'A client disconnect stops the server-side investigation', refs: ['OWASP LLM10', 'Sentinel safety rule 13'], expected: 'No further model calls after the client aborts' },
  async () => {
    delayMs = 150;
    const ac = new AbortController();
    const before = modelCalls;
    const pending = fetch(`${base}/api/investigate/${INC}`, { signal: ac.signal, headers: site('same-origin') }).then((r) => r.text()).catch(() => '');
    if (!(await waitFor(() => modelCalls > before))) return { status: 'ERROR', observed: 'run never reached the model' };
    ac.abort();
    await pending;
    const atAbort = modelCalls;
    await sleep(1500);
    const after = modelCalls - atAbort;
    delayMs = 20;
    await sleep(6000); // let the orphaned run finish before later probes count anything
    return { status: after <= 1 ? 'PASS' : 'FAIL', observed: `${after} model calls in the 1.5 s after the client disconnected` };
  },
);

// The scripted runs above never submit a report, so they end in an error; B09a drives one that
// completes. Both must record what actually answered, not only the configured model name.
async function newestRun(where: (run: any) => boolean) {
  const dir = path.join(process.env.INCIDENTLENS_RUNS_DIR!, INC);
  const runs = await Promise.all((await readdir(dir)).filter((f) => f.endsWith('.json')).sort().map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
  return runs.filter(where).at(-1);
}
const servedIn = (models: any) => Object.values(models ?? {}).map((m: any) => m.served);

await scenario(
  { id: 'B09a', title: 'A completed run records the model the API said served it', refs: ['OWASP LLM09', 'Sentinel provenance'], expected: 'report.stats.models[*].served names the responding model' },
  async () => {
    const { revisionScript } = await import('../test/fake-model.ts');
    script = revisionScript.map((c: any) => ({ ...c }));
    await call(`/api/investigate/${INC}`, { headers: site('same-origin') });
    const run = await newestRun((r) => r.events.some((e: any) => e.type === 'report'));
    if (!run) return { status: 'ERROR', observed: 'the scripted run did not complete' };
    const claimed = run.events.find((e: any) => e.type === 'start')?.model;
    const served = servedIn(run.events.find((e: any) => e.type === 'report').stats.models);
    return { status: served.includes('sentinel-scripted') ? 'PASS' : 'FAIL', observed: `record names "${claimed}" as configured; served: ${JSON.stringify(served)}` };
  },
);

await scenario(
  { id: 'B09b', title: 'A failed run still records its spend and the model that answered', refs: ['OWASP LLM10', 'Sentinel provenance'], expected: 'The error event carries usage with served model names' },
  async () => {
    const run = await newestRun((r) => r.events.some((e: any) => e.type === 'error'));
    if (!run) return { status: 'ERROR', observed: 'no failed run was recorded' };
    const err = run.events.find((e: any) => e.type === 'error');
    const served = servedIn(err.usage?.models);
    return { status: served.includes('sentinel-scripted') ? 'PASS' : 'FAIL', observed: err.usage ? `error event usage: $${err.usage.cost_usd}, served ${JSON.stringify(served)}` : 'error event has no usage at all' };
  },
);

// ---------------------------------------------------------------------------------------------
// B: evidence and scoring

await scenario(
  { id: 'B04', title: 'An elided quote cannot stitch distant lines into one statement', refs: ['OWASP LLM09', 'Sentinel B04'], expected: 'Fragments far apart are rejected even inside a wide cited range' },
  async () => {
    const contiguous = await verifyEvidence(INC, { artifact: 'logs/payment-service.log', start_line: 11, end_line: 11, quote: 'fraud check slow orderId=ord_88241 tookMs=4120' });
    if (contiguous.status !== 'verified') return { status: 'ERROR', observed: `positive control: ${contiguous.status}` };
    // Line 4 says the pool started fine; line 22 is a timeout 18 lines later.
    const stitched = await verifyEvidence(INC, { artifact: 'logs/payment-service.log', start_line: 1, end_line: 33, quote: 'HikariPool-1 - Start completed ... request timed out after 30000ms' });
    return { status: stitched.status === 'verified' ? 'FAIL' : 'PASS', observed: `contiguous control verified; quote stitched from lines 4 and 22 with "...": ${stitched.status}` };
  },
);

await scenario(
  { id: 'B03', title: 'A real quote cited for a false conclusion is flagged', refs: ['OWASP LLM09', 'Sentinel B03'], expected: 'Claim-level check marks the inference unsupported' },
  async () => {
    const check = await verifyEvidence(INC, { artifact: 'logs/payment-service.log', start_line: 10, end_line: 10, quote: 'GC(41) Pause Young (Normal) (G1 Evacuation Pause) 412M->188M(1024M) 18.442ms' });
    return { status: 'FAIL', observed: `quote verified (${check.status}) while cited for "GC pauses caused the outage"; no claim-level check exists`, disposition: 'known limit, stated in README; claim verification is issue #6' };
  },
);

await scenario(
  { id: 'B19', title: 'Scoring cannot be passed by naming the right terms in a wrong diagnosis', refs: ['Sentinel B19', 'evaluation integrity'], expected: 'A report that negates every key term scores wrong' },
  async () => {
    const gt = await loadGroundTruth(INC);
    const right = scoreReport({ summary: 'Fraud call inside @Transactional exhausted the Hikari pool.' }, gt).correct;
    const unrelated = scoreReport({ summary: 'A DNS outage in the gateway.' }, gt).correct;
    if (!right || unrelated) return { status: 'ERROR', observed: `controls wrong: correct report ${right}, unrelated report ${unrelated}` };
    const negated = scoreReport({ summary: 'Not Hikari pool exhaustion, not the fraud call and not @Transactional: the cause is a DNS outage.' }, gt).correct;
    return { status: negated ? 'FAIL' : 'PASS', observed: `correct report scores correct, unrelated scores wrong (controls); report negating all three terms scores ${negated ? 'CORRECT' : 'wrong'}`, disposition: negated ? 'known limit of keyword scoring; live results must keep saying "keyword scoring"' : undefined };
  },
);

await scenario(
  { id: 'H-EV1', title: 'A rejected fact is recorded in full, so the rejection can be audited', refs: ['OWASP A09', 'Sentinel §6'], expected: 'The fact_rejected event keeps the whole quote (or flags truncation)' },
  async () => {
    const events: any[] = [];
    const board = new Board(INC, (e: any) => events.push(e));
    const quote = `${'invented log line '.repeat(30)}END`;
    await board.postFact('signals', { claim: 'sentinel probe', artifact: 'logs/payment-service.log', start_line: 1, end_line: 2, quote });
    const rejected = events.find((e) => e.type === 'fact_rejected');
    if (!rejected) return { status: 'ERROR', observed: 'fabricated fact was not rejected' };
    const complete = rejected.quote === quote;
    const flagged = rejected.quote_truncated === true;
    return { status: complete || flagged ? 'PASS' : 'FAIL', observed: `posted ${quote.length} chars; record kept ${rejected.quote.length}${complete ? ', complete' : flagged ? ', flagged as truncated' : ', silently cut'}` };
  },
);

// ---------------------------------------------------------------------------------------------
// H / G20: audit integrity

await scenario(
  { id: 'G20', title: 'Deleting the newest audit entries is detected', refs: ['OWASP A09', 'Sentinel §6'], expected: 'verify() fails after the tail is truncated' },
  async () => {
    const file = path.join(tmp, 'audit-probe.jsonl');
    const log = new AuditLog(file);
    for (const a of ['one', 'two', 'three']) await log.append('sentinel', a, 'probe');
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    const edited = [...lines];
    edited[1] = edited[1].replace('"two"', '"TWO"');
    await writeFile(file, edited.join('\n') + '\n');
    const tamper = await new AuditLog(file).verify();
    if (tamper.ok) return { status: 'ERROR', observed: 'positive control: an edited middle entry still verified' };
    await writeFile(file, lines.slice(0, 2).join('\n') + '\n');
    const truncated = await new AuditLog(file).verify();
    return { status: truncated.ok ? 'FAIL' : 'PASS', observed: `edited entry detected (control); after deleting the last entry verify() says ok=${truncated.ok}, length ${truncated.length}`, disposition: truncated.ok ? 'needs an external anchor (issue #1 durable store); a local chain cannot prove its own tail' : undefined };
  },
);

// ---------------------------------------------------------------------------------------------
// Existing suites mapped to catalog IDs: executed here, not just referenced.

function suite(file: string) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: '', ACCESS_SECRET: '' } });
  const pass = Number(/^# pass (\d+)/m.exec(r.stdout)?.[1] ?? 0);
  const fail = Number(/^# fail (\d+)/m.exec(r.stdout)?.[1] ?? 0);
  return { pass, fail, counted: pass + fail > 0, ok: r.status === 0 && pass > 0 && fail === 0 };
}
for (const [id, title, file, refs] of [
  ['H01-H08', 'Governance: deny, stale hash, expiry, veto, kill switch, conflicts, restart', 'test/governance.test.ts', ['Sentinel H01-H08']],
  ['D16/D17', 'Governance races: veto and kill switch against execution', 'test/governance-races.test.ts', ['Sentinel D16', 'Sentinel D17']],
  ['H11-H13/A02', 'Policy guard, constitution pin, injection quarantine, audit chain', 'test/guard.test.ts', ['Sentinel H11', 'Sentinel H12', 'Sentinel A02']],
  ['C09', 'Path containment, symlink and junction escape, fail-closed exposure', 'test/paths.test.ts', ['CWE-22', 'CWE-59']],
] as const) {
  await scenario({ id, title, refs: [...refs], expected: `${file} passes` }, async () => {
    const s = suite(file);
    // Nothing counted means the runner could not read the suite, not that it passed or failed.
    return { status: !s.counted ? 'ERROR' : s.ok ? 'PASS' : 'FAIL', observed: `${file}: ${s.pass} passed, ${s.fail} failed` };
  });
}

// ---------------------------------------------------------------------------------------------

const UNTESTED = [
  ['A01, A03-A15', 'Live-model prompt-injection resistance beyond the inc-005 fixture (needs a bounded, opt-in Muse probe pack)'],
  ['B01-B20 (except B03, B04, B09, B19)', 'Truth and focus measures need the claim verifier and focus governor (issues #6, #7)'],
  ['C01-C03, C05-C07, C10-C20', 'RAG poisoning, memory and multi-agent trust scenarios (issue #9)'],
  ['D02-D04, D06-D07, D09, D11-D12, D14-D15, D18-D20', 'Covered partly by test/access.test.ts and governance tests; no revocation or tenants exist yet (issue #2)'],
  ['E01-E20', 'No compile/test sandbox exists, so generated code is never executed (issue #3)'],
  ['F01-F04, F06-F20 and cloud importers', 'Reflex tests exist in test/reflexes.test.ts; cloud importers are not built (issue #11)'],
  ['G01-G10, G12-G19', 'No SAST, dependency, secret or CI-permission scanners run yet (issue #15)'],
  ['H14-H20', 'Held-out evaluation, decoys and alert flooding are not built (issues #10, #13)'],
  ['I01-I12', 'Discovery research (mutation, metamorphic, differential) not started'],
];

const counts = Object.fromEntries((['PASS', 'FAIL', 'ERROR', 'UNTESTED'] as Status[]).map((s) => [s, results.filter((r) => r.status === s).length]));
const report = {
  pack: 'sentinel-smoke',
  version: 1,
  at: new Date().toISOString(),
  commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
  dirty: spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim().length > 0,
  node: process.version,
  environment: 'isolated-fixture: temp dirs, local scripted model, synthetic key; no network beyond 127.0.0.1',
  live_inference: false,
  counts,
  results,
  untested: UNTESTED.map(([ids, why]) => ({ ids, status: 'UNTESTED', why })),
};

for (const r of results) console.log(`${r.status.padEnd(5)} ${r.id.padEnd(12)} ${r.title}\n      ${r.observed}${r.disposition ? `\n      disposition: ${r.disposition}` : ''}`);
console.log(`\n${results.length} scenarios: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.ERROR} ERROR. Not covered here: ${UNTESTED.length} catalog groups (listed as UNTESTED in the JSON).`);
const outArg = process.argv.indexOf('--out');
if (outArg > 0) {
  await mkdir(path.dirname(process.argv[outArg + 1]), { recursive: true });
  await writeFile(process.argv[outArg + 1], JSON.stringify(report, null, 2));
}
app.close();
fake.close();
await rm(tmp, { recursive: true, force: true }).catch(() => {});
process.exit(counts.FAIL || counts.ERROR ? 1 : 0);
