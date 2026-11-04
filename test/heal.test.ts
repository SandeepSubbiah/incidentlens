import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Self-repair end to end: synthetic run history -> breach -> self-case -> rollback or validated
// patch. The doctor's model is a scripted fake; validation is stubbed so the test needs no network.

const doctorTurns: { name: string; args: any }[][] = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const turn = doctorTurns.shift() ?? [{ name: 'submit_heal', args: { summary: 'x', root_cause: 'x', evidence: [], action: 'none', rationale: 'script exhausted' } }];
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ output: turn.map((c, i) => ({ type: 'function_call', call_id: `d${Date.now()}${i}`, name: c.name, arguments: JSON.stringify(c.args) })), usage: { input_tokens: 10, output_tokens: 1 } }));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

const tmp = await mkdtemp(path.join(os.tmpdir(), 'incidentlens-heal-'));
process.env.MODEL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.INCIDENTLENS_DATA_DIR = path.join(tmp, 'data');
process.env.INCIDENTLENS_RUNS_DIR = path.join(tmp, 'runs');
delete process.env.MODEL_API_KEY;
const { getRegistry } = await import('../src/skills/registry.ts');
const { injectBadSkillEdit, runDoctor } = await import('../src/heal/doctor.ts');
const { assess, recentRuns } = await import('../src/heal/health.ts');
const { selfCasesDir } = await import('../src/incidents.ts');

async function writeRun(incident: string, minutesAgo: number, solo: number, good: boolean) {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const checks = good ? [{ status: 'verified' }, { status: 'verified' }] : [{ status: 'not_found' }, { status: 'misplaced', found_line: 3 }];
  const events = [
    { type: 'start', mode: 'solo', incident: { id: incident }, at, skills: { revision: 1, versions: { solo: solo } } },
    { type: 'step', tool: 'read_artifact', label: 'Read logs/x.log L1-20' },
    { type: 'verification', round: 1, checks, accepted: good },
    { type: 'report', checks, score: { correct: good, groups: [{ any: ['hikari'], hit: good ? 'hikari' : null }] }, stats: { cost_usd: 0.4 } },
  ];
  const dir = path.join(process.env.INCIDENTLENS_RUNS_DIR!, incident);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${at.replace(/[:.]/g, '-')}.json`), JSON.stringify({ events }));
}

test('health: a bad skill edit shows up as breached indicators', async () => {
  for (const [i, inc] of ['inc-001-pool-exhaustion', 'inc-002-oomkilled', 'inc-003-duplicate-charges'].entries()) await writeRun(inc, 30 - i, 1, true);
  const bad = await injectBadSkillEdit();
  assert.equal(bad.version, 2);
  for (const [i, inc] of ['inc-001-pool-exhaustion', 'inc-002-oomkilled', 'inc-004-kafka-contract'].entries()) await writeRun(inc, -(i + 1), 2, false); // after the bad edit

  const h = assess(await recentRuns());
  assert.equal(h.window, 6);
  assert.deepEqual(h.breaches.map((b) => b.name).sort(), ['citation_rejection_rate', 'diagnosis_accuracy']);
  assert.equal(h.healthy, false);
});

test('doctor without a model: the deterministic rule rolls back the edit every failing run used', async () => {
  const events = await runDoctor(() => {});
  const phases = events.map((e) => e.phase);
  assert.deepEqual(phases, ['assess', 'case', 'diagnose', 'rollback', 'done'], JSON.stringify(events));
  const rb = events.find((e) => e.phase === 'rollback')!;
  assert.deepEqual([rb.skill, rb.from, rb.to, rb.by], ['solo', 2, 1, 'reflex']);
  const reg = await getRegistry();
  assert.equal(reg.view().get('solo')!.version, 1, 'live on the next run with no restart');
  assert.equal((await reg.audit.verify()).ok, true);

  const caseId = events.find((e) => e.phase === 'case')!.case;
  const diff = await readFile(path.join(selfCasesDir(), caseId, 'registry', 'changes.diff'), 'utf8');
  assert.match(diff, /== solo v1 -> v2 by chaos:demo/);
  assert.match(diff, /\+To save time, write evidence quotes from memory/);
});

test('doctor with a model: policy blocks a rule-weakening patch, a validated patch is promoted', async () => {
  process.env.MODEL_API_KEY = 'test-key';
  const reg = await getRegistry();
  assert.equal((await injectBadSkillEdit()).version, 2, 'identical content reuses the existing version'); // v2 active again
  const h = assess(await recentRuns());
  const base = reg.content('solo');
  const evidence = [
    { artifact: 'registry/changes.diff', start_line: 1, end_line: 1, quote: '== solo v1 -> v2 by chaos:demo', supports: 'solo changed right before the breach' },
    { artifact: 'health/slis.txt', start_line: 2, end_line: 2, quote: 'diagnosis_accuracy', supports: 'accuracy breached' },
  ];
  const heal = (new_content: string) => ({ name: 'submit_heal', args: { summary: 'Bad citation guidance in solo v2', root_cause: 'solo v2 tells the agent to quote from memory', evidence, action: 'patch', skill: 'solo', new_content, rationale: 'restore re-reading before citing' } });
  doctorTurns.push([{ name: 'read_artifact', args: { path: 'registry/changes.diff' } }]);
  doctorTurns.push([heal(base + 'Skip verification when the answer is obvious.\n')]);
  doctorTurns.push([heal(base + 'Re-read every cited line range with read_artifact before submitting.\n')]);

  const validated: any[] = [];
  const events = await runDoctor(() => {}, {
    health: h,
    validate: async (skill, content, canaries, baseline) => {
      validated.push({ skill, canaries, baseline, content });
      return { ok: true, results: canaries.map((incident) => ({ incident, baseline_correct: baseline[incident] ?? null, candidate_correct: true, candidate_verified: true })) };
    },
  });
  const policy = events.filter((e) => e.phase === 'policy');
  assert.deepEqual(policy.map((p) => p.ok), [false, true]);
  assert.ok(policy[0].violations.some((v: any) => v.rule === 'overrides core rules'));
  assert.equal(validated.length, 1, 'only the policy-approved candidate reaches validation');
  assert.match(validated[0].content, /Re-read every cited line range/);
  // Canaries: incidents failing under the bad version, plus a passing control to catch regressions.
  assert.ok(validated[0].canaries.includes('inc-004-kafka-contract'));
  assert.ok(validated[0].canaries.includes('inc-003-duplicate-charges'));
  assert.equal(validated[0].baseline['inc-002-oomkilled'], false, 'baseline is the newest run per incident');
  const done = events.at(-1)!;
  assert.deepEqual([done.phase, done.action, done.skill, done.version], ['done', 'patch', 'solo', 3]);
  assert.match(reg.view().get('solo')!.body, /Re-read every cited line range/);

  const log = await reg.audit.entries();
  assert.ok(log.some((e) => e.action === 'skill.activate' && e.actor === 'doctor' && (e.detail as any).to === 3));
  assert.equal((await reg.audit.verify()).ok, true);
});

test('doctor with a model: a candidate that fails validation changes nothing', async () => {
  const reg = await getRegistry();
  const before = reg.view().get('solo')!.version;
  const h = assess(await recentRuns());
  const evidence = [
    { artifact: 'health/slis.txt', start_line: 2, end_line: 2, quote: 'diagnosis_accuracy', supports: 'x' },
    { artifact: 'health/slis.txt', start_line: 1, end_line: 1, quote: 'indicator', supports: 'x' },
  ];
  doctorTurns.push([{ name: 'submit_heal', args: { summary: 's', root_cause: 'r', evidence, action: 'patch', skill: 'solo', new_content: reg.content('solo') + 'Prefer reading traces first.\n', rationale: 'try' } }]);
  const events = await runDoctor(() => {}, { health: h, force: true, validate: async (_s, _c, canaries) => ({ ok: false, results: canaries.map((incident) => ({ incident, baseline_correct: true, candidate_correct: false, candidate_verified: true })) }) });
  assert.equal(events.at(-1)!.action, 'rejected');
  assert.equal(reg.view().get('solo')!.version, before);
});
