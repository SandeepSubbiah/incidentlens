import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Concurrency, partial failure and restart behaviour of the governance gate. Each test states
// the invariant it protects; the restart tests use a separate Node process so no in-memory
// state survives.

const DATA = await mkdtemp(path.join(os.tmpdir(), 'incidentlens-races-'));
process.env.INCIDENTLENS_DATA_DIR = DATA;
const ROOT = path.resolve(import.meta.dirname, '..');
const { propose, decide, setKillSwitch, getChange } = await import('../src/governance/changes.ts');
const { getRegistry } = await import('../src/skills/registry.ts');
const { auditLogAt } = await import('../src/guard/audit.ts');

const admin = (sub: string) => ({ sub, role: 'admin' });
const judge = { sub: 'judge-1', role: 'judge' };
const LEDGER = path.join(DATA, 'governance', 'changes.json');
const audit = () => auditLogAt(path.join(DATA, 'audit.jsonl')).entries();

async function skillChange(skill: string, line: string) {
  const reg = await getRegistry();
  return propose({ kind: 'skill-change', title: `patch ${skill}`, requester: 'doctor', risk: 'A1', target: `skill:${skill}`, payload: { skill, content: `${reg.content(skill)}\n${line}\n`, rationale: line } });
}

function remediation() {
  return propose({ kind: 'remediation', title: 'fix', requester: 'incidentlens:solo', risk: 'A3', target: 'payment-service:PaymentService.java', payload: { incident: 'inc-001-pool-exhaustion', artifact: 'src/main/java/com/acme/payments/PaymentService.java', patch: '-        FraudVerdict verdict = fraudClient.score(payment);\n+        FraudVerdict verdict = preScoredVerdict(req);\n', explanation: 'x' } });
}

// Runs governance code in a fresh Node process against the same data directory.
function inFreshProcess(body: string): any {
  const code = `const g = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/governance/changes.ts')).href)});
const r = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/skills/registry.ts')).href)});
const out = await (async () => { ${body} })();
console.log(JSON.stringify(out));`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, INCIDENTLENS_DATA_DIR: DATA }, encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim().split('\n').at(-1)!);
}

test('conflicting operations: two requests built on the same version cannot both apply (no lost update)', async () => {
  const reg = await getRegistry();
  const a = await skillChange('solo', 'Change A: re-read cited lines.');
  const b = await skillChange('solo', 'Change B: prefer traces first.');
  assert.deepEqual(b.conflicts, [a.id], 'the second request is flagged as conflicting when proposed');

  assert.equal((await decide(a.id, admin('sandeep'), 'approve', 'ok', a.hash)).state, 'completed');
  const second = await decide(b.id, admin('sandeep'), 'approve', 'ok', b.hash);
  assert.equal(second.state, 'denied');
  assert.match(second.rule!, /^R7/);
  const live = reg.content('solo');
  assert.match(live, /Change A/);
  assert.doesNotMatch(live, /Change B/, 'B was built on the old version and must not overwrite A');

  // Negative control: a request for a different target is unaffected.
  const other = await skillChange('commander', 'Change C: confirm the timeline first.');
  assert.deepEqual(other.conflicts, []);
  assert.equal((await decide(other.id, admin('sandeep'), 'approve', 'ok', other.hash)).state, 'completed');
});

test('revocation racing execution: a veto and the final approval never both take effect', async () => {
  for (let round = 0; round < 8; round++) {
    const cr = await remediation();
    await decide(cr.id, admin('sandeep'), 'approve', 'first', cr.hash);
    const approve = () => decide(cr.id, admin('alex'), 'approve', 'second', cr.hash);
    const veto = () => decide(cr.id, judge, 'veto', 'freeze', cr.hash);
    const results = await Promise.allSettled(round % 2 ? [approve(), veto()] : [veto(), approve()]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, `round ${round}: exactly one decision wins`);
    const final = (await getChange(cr.id))!;
    const ids = (await audit()).filter((e) => e.target === cr.id).map((e) => e.action);
    if (final.state === 'completed') assert.ok(!ids.includes('change.veto') && final.executed_at, `round ${round}`);
    else {
      assert.equal(final.state, 'vetoed');
      assert.ok(!ids.includes('change.completed') && !final.executed_at, `round ${round}: vetoed work never executes`);
    }
  }
});

test('kill switch racing the final approval: nothing executes after the switch is engaged', async () => {
  const outcomes = new Set<string>();
  for (let round = 0; round < 12; round++) {
    const cr = await skillChange('fixer', `Round ${round}: state the rollback first.`);
    // Vary when the switch lands so some rounds hit the window between the check and execution.
    const kill = async () => {
      await new Promise((r) => setTimeout(r, [0, 1, 2, 4, 8, 40][round % 6]));
      return setKillSwitch(true, admin('ops'), `drill ${round}`);
    };
    // Even rounds engage the switch first; odd rounds let it land while the approval executes.
    const outcome =
      round % 2 === 0
        ? await (async () => {
            const k = setKillSwitch(true, admin('ops'), `drill ${round}`);
            const d = decide(cr.id, admin('sandeep'), 'approve', 'go', cr.hash);
            const [dr] = await Promise.allSettled([d, k]);
            return [dr];
          })()
        : await Promise.allSettled([decide(cr.id, admin('sandeep'), 'approve', 'go', cr.hash), kill()]);
    const log = await audit();
    const completed = log.find((e) => e.target === cr.id && e.action === 'change.completed');
    const killOn = log.filter((e) => e.action === 'governance.kill.on').at(-1)!;
    outcomes.add(completed ? 'executed' : 'blocked');
    if (completed) assert.ok(completed.seq < killOn.seq, `round ${round}: executed after the kill switch (seq ${completed.seq} > ${killOn.seq})`);
    else {
      assert.equal(outcome[0].status, 'rejected');
      assert.equal((await getChange(cr.id))!.state, 'awaiting_approval');
    }
    await setKillSwitch(false, admin('ops'), 'drill over');
  }
  assert.deepEqual([...outcomes].sort(), ['blocked', 'executed'], 'both orderings must occur, or the race was never exercised');
});

test('partial commit: a failure after the change is live is compensated; a failed compensation is reported, not hidden', async () => {
  const reg = await getRegistry();
  const real = reg.activate.bind(reg);
  const before = reg.view().get('platform')!.version;

  // Failure before the commit point: nothing changes, the stored version stays inert.
  reg.activate = async () => {
    throw new Error('simulated storage failure');
  };
  const early = await skillChange('platform', 'Early failure.');
  const r1 = await decide(early.id, admin('sandeep'), 'approve', 'ok', early.hash);
  assert.equal(r1.state, 'failed');
  assert.equal(reg.view().get('platform')!.version, before, 'the previous version is still live');
  await assert.rejects(decide(early.id, admin('alex'), 'approve', 'retry', early.hash), /R-FINAL/, 'a failed request is not silently retried');

  // Failure after the commit point (the write landed, the call reported an error): restore.
  let calls = 0;
  reg.activate = async (...args: Parameters<typeof real>) => {
    calls++;
    await real(...args);
    if (calls === 1) throw new Error('timeout after write');
  };
  const late = await skillChange('platform', 'Late failure, compensated.');
  const r2 = await decide(late.id, admin('sandeep'), 'approve', 'ok', late.hash);
  assert.equal(r2.state, 'rolled_back');
  assert.match(r2.rule!, /^R9/);
  assert.equal(reg.view().get('platform')!.version, before, 'compensation restored the previous version');

  // Compensation also fails: state says so and names the live version.
  calls = 0;
  reg.activate = async (...args: Parameters<typeof real>) => {
    calls++;
    if (calls === 1) {
      await real(...args);
      throw new Error('timeout after write');
    }
    throw new Error('storage unavailable');
  };
  const stuck = await skillChange('platform', 'Late failure, compensation fails.');
  const r3 = await decide(stuck.id, admin('sandeep'), 'approve', 'ok', stuck.hash);
  assert.equal(r3.state, 'recovery_incomplete');
  assert.match(r3.rule!, /needs a human/);
  assert.notEqual(reg.view().get('platform')!.version, before, 'honest: the new version is live and the record says so');
  reg.activate = real;
  await reg.rollback('platform', 'human:sandeep', 'manual recovery');
});

test('restart during approval: approvals persist, the second approver completes it once in a new process', async () => {
  const cr = await remediation();
  await decide(cr.id, admin('sandeep'), 'approve', 'before restart', cr.hash);
  const dup = inFreshProcess(`return g.decide(${JSON.stringify(cr.id)}, { sub: 'sandeep', role: 'admin' }, 'approve', 'again', ${JSON.stringify(cr.hash)}).catch((e) => ({ error: e.message }));`);
  assert.match(dup.error, /R5/, 'separation of duties survives a restart');
  const after = inFreshProcess(`return g.decide(${JSON.stringify(cr.id)}, { sub: 'alex', role: 'admin' }, 'approve', 'after restart', ${JSON.stringify(cr.hash)});`);
  assert.equal(after.state, 'completed');
  assert.deepEqual(after.decisions.map((d: any) => d.actor), ['sandeep', 'alex']);
  assert.equal((await audit()).filter((e) => e.target === cr.id && e.action === 'change.completed').length, 1);
  assert.equal((await auditLogAt(path.join(DATA, 'audit.jsonl')).verify()).ok, true);
});

test('restart during execution: the start is recorded first; an interrupted execution is never re-run', async () => {
  const reg = await getRegistry();
  // Write-ahead: while the change executes, the ledger already says "executing".
  const real = reg.addVersion.bind(reg);
  let seen = '';
  const probe = await skillChange('skeptic', 'Probe write-ahead.');
  reg.addVersion = async (...args: Parameters<typeof real>) => {
    seen = JSON.parse(readFileSync(LEDGER, 'utf8')).find((c: any) => c.id === probe.id).state;
    return real(...args);
  };
  await decide(probe.id, admin('sandeep'), 'approve', 'ok', probe.hash);
  reg.addVersion = real;
  assert.equal(seen, 'executing');

  // Simulate a crash after the write-ahead record: a fresh process must not re-run it.
  const crashed = await skillChange('skeptic', 'Interrupted change.');
  const ledger = JSON.parse(await readFile(LEDGER, 'utf8'));
  ledger.find((c: any) => c.id === crashed.id).state = 'executing';
  await writeFile(LEDGER, JSON.stringify(ledger));
  const liveBefore = reg.view().get('skeptic')!.version;
  const out = inFreshProcess(`const c = (await g.listChanges()).find((x) => x.id === ${JSON.stringify(crashed.id)});
const retry = await g.decide(c.id, { sub: 'alex', role: 'admin' }, 'approve', 'retry', c.hash).catch((e) => ({ error: e.message }));
const reg = await r.getRegistry();
return { state: c.state, rule: c.rule, retry, live: reg.view().get('skeptic').version };`);
  assert.equal(out.state, 'recovery_incomplete');
  assert.match(out.rule, /^R8/);
  assert.match(out.retry.error, /R-FINAL/);
  assert.equal(out.live, liveBefore, 'the interrupted change was not executed again');
});
