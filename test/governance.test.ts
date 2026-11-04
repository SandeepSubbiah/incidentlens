import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.INCIDENTLENS_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'incidentlens-gov-'));
const { propose, decide, setKillSwitch, changeHash, getChange } = await import('../src/governance/changes.ts');
const { getRegistry } = await import('../src/skills/registry.ts');
const { applyUnifiedPatch } = await import('../src/sandbox.ts');
const { auditLogAt } = await import('../src/guard/audit.ts');

const admin = (sub: string) => ({ sub, role: 'admin' });
const judge = { sub: 'judge-1', role: 'judge' };
const SVC = 'src/main/java/com/acme/payments/PaymentService.java';
const fixPatch = '-        FraudVerdict verdict = fraudClient.score(payment);\n+        FraudVerdict verdict = preScoredVerdict(req);\n';

async function skillChange(now?: Date) {
  const reg = await getRegistry();
  return propose({ kind: 'skill-change', title: 'patch solo', requester: 'doctor', risk: 'A1', target: 'skill:solo', payload: { skill: 'solo', content: reg.content('solo') + '\nRe-read cited lines.\n', rationale: 'test' }, now });
}

test('A1 skill change: requester, wrong role and stale hash are refused; one admin approval executes it once', async () => {
  const reg = await getRegistry();
  const cr = await skillChange();
  assert.equal(cr.state, 'awaiting_approval');
  assert.equal(cr.hash, changeHash('skill-change', 'skill:solo', cr.payload));
  await assert.rejects(decide(cr.id, admin('doctor'), 'approve', 'mine', cr.hash), /R5/);
  await assert.rejects(decide(cr.id, judge, 'approve', 'judges cannot approve', cr.hash), /R-ROLE/);
  await assert.rejects(decide(cr.id, admin('sandeep'), 'approve', 'reviewed another version', 'f'.repeat(64)), /R4/);
  assert.equal(reg.view().get('solo')!.version, 1, 'refused decisions change nothing');

  const done = await decide(cr.id, admin('sandeep'), 'approve', 'reviewed', cr.hash);
  assert.equal(done.state, 'completed');
  assert.equal(reg.view().get('solo')!.version, 2);
  await assert.rejects(decide(cr.id, admin('alex'), 'approve', 'again', cr.hash), /R-FINAL/);
  assert.equal(reg.list().find((s) => s.name === 'solo')!.versions.length, 2, 'executed exactly once');
});

test('A3 remediation: needs two different approvers, a veto beats an earlier approval, execution is simulated', async () => {
  const payload = { incident: 'inc-001-pool-exhaustion', artifact: SVC, patch: fixPatch, explanation: 'x' };
  const vetoed = await propose({ kind: 'remediation', title: 'fix', requester: 'incidentlens:solo', risk: 'A3', target: `payment-service:${SVC}`, payload });
  assert.equal(vetoed.required_approvals, 2);
  assert.equal(vetoed.execution, 'simulated');
  const one = await decide(vetoed.id, admin('sandeep'), 'approve', 'ok', vetoed.hash);
  assert.equal(one.state, 'awaiting_approval');
  assert.match(one.rule!, /1 of 2/);
  await assert.rejects(decide(vetoed.id, admin('sandeep'), 'approve', 'twice', vetoed.hash), /R5/);
  const v = await decide(vetoed.id, judge, 'veto', 'customer freeze window', vetoed.hash);
  assert.equal(v.state, 'vetoed');
  await assert.rejects(decide(vetoed.id, admin('alex'), 'approve', 'late', vetoed.hash), /R-FINAL/);

  const ok = await propose({ kind: 'remediation', title: 'fix', requester: 'incidentlens:solo', risk: 'A3', target: `payment-service:${SVC}`, payload });
  await decide(ok.id, admin('sandeep'), 'approve', 'ok', ok.hash);
  const done = await decide(ok.id, admin('alex'), 'approve', 'ok', ok.hash);
  assert.equal(done.state, 'completed');
  assert.equal(done.result!.mode, 'simulated');
  assert.equal(done.result!.status, 'applied');
  assert.match(String(done.result!.diff), /\+        FraudVerdict verdict = preScoredVerdict\(req\);/);
  const onDisk = await readFile(path.resolve(import.meta.dirname, '..', 'incidents', 'inc-001-pool-exhaustion', SVC), 'utf8');
  assert.match(onDisk, /FraudVerdict verdict = fraudClient\.score\(payment\);/, 'the evidence on disk is never modified');
});

test('expiry fails closed, A4 is prohibited, the kill switch blocks approvals but not rollbacks', async () => {
  const stale = await skillChange(new Date(Date.now() - 5 * 3600_000));
  await assert.rejects(decide(stale.id, admin('sandeep'), 'approve', 'late', stale.hash), /R3/);
  assert.equal((await getChange(stale.id))!.state, 'expired');

  const a4 = await propose({ kind: 'remediation', title: 'drop table', requester: 'incidentlens:solo', risk: 'A4', target: 'db:orders', payload: { incident: 'x', artifact: 'x', patch: 'x' } });
  assert.equal(a4.state, 'denied');

  const pending = await skillChange();
  await setKillSwitch(true, admin('sandeep'), 'drill');
  await assert.rejects(decide(pending.id, admin('alex'), 'approve', 'during freeze', pending.hash), /R1/);
  const rb = await propose({ kind: 'skill-rollback', title: 'rollback', requester: 'doctor:reflex', risk: 'A1', target: 'skill:solo', payload: { skill: 'solo', reason: 'regression' } });
  assert.equal(rb.state, 'completed', 'restoring a validated version stays possible during a freeze');
  await assert.rejects(setKillSwitch(false, judge, 'not allowed'), /R-ROLE/);
  await setKillSwitch(false, admin('sandeep'), 'drill over');
  // The rollback changed the live version, so the pending change is stale and must not undo it.
  const outdated = await decide(pending.id, admin('alex'), 'approve', 'after freeze', pending.hash);
  assert.equal(outdated.state, 'denied');
  assert.match(outdated.rule!, /^R7/);
  const fresh = await skillChange();
  assert.equal((await decide(fresh.id, admin('alex'), 'approve', 'against the live version', fresh.hash)).state, 'completed');

  const chain = await auditLogAt(path.join(process.env.INCIDENTLENS_DATA_DIR!, 'audit.jsonl')).verify();
  assert.equal(chain.ok, true);
  const actions = (await auditLogAt(path.join(process.env.INCIDENTLENS_DATA_DIR!, 'audit.jsonl')).entries()).map((e) => e.action);
  for (const a of ['change.proposed', 'change.decision.refused', 'change.veto', 'change.completed', 'change.expired', 'governance.kill.on', 'skill.activate']) assert.ok(actions.includes(a), `audit records ${a}`);
});

test('sandbox applier: real hunks apply with original indentation; invented context and anchorless hunks fail', () => {
  const file = ['class A {', '    void f() {', '        int x = 1;', '        call(x);', '    }', '}'];
  const ok = applyUnifiedPatch(file, '@@ -2,3 +2,3 @@\n void f() {\n-        int x = 1;\n+        int x = 2;\n         call(x);\n');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.lines, ['class A {', '    void f() {', '        int x = 2;', '        call(x);', '    }', '}']);
  const invented = applyUnifiedPatch(file, '-        int y = 9;\n+        int y = 10;\n');
  assert.equal(invented.ok, false);
  assert.equal(applyUnifiedPatch(file, '+ only an addition\n').ok, false);
});
