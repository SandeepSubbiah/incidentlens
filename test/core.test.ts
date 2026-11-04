import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listArtifacts, listIncidents, loadGroundTruth } from '../src/incidents.ts';
import { runTool } from '../src/tools.ts';
import { verifyEvidence, verifyPatch } from '../src/verify.ts';
import { scoreReport } from '../src/score.ts';

const INC = 'inc-001-pool-exhaustion';
const SVC = 'src/main/java/com/acme/payments/PaymentService.java';

test('all incidents load and have a ground truth', async () => {
  const incidents = await listIncidents();
  assert.equal(incidents.length, 5);
  for (const i of incidents) {
    const gt = await loadGroundTruth(i.id);
    assert.ok(gt.must_mention.length > 0, i.id);
    const arts = (await listArtifacts(i.id)).map((a) => a.path);
    assert.ok(arts.includes(gt.fix_artifact), `${i.id}: fix_artifact ${gt.fix_artifact} must exist`);
  }
});

test('agent cannot see or read the answer key', async () => {
  const arts = (await listArtifacts(INC)).map((a) => a.path);
  assert.ok(!arts.includes('ground-truth.json'));
  assert.ok(!arts.includes('incident.json'));
  await assert.rejects(runTool(INC, 'read_artifact', { path: 'ground-truth.json' }), /no such artifact/);
  await assert.rejects(runTool(INC, 'read_artifact', { path: './ground-truth.json' }), /no such artifact/);
  await assert.rejects(runTool(INC, 'read_artifact', { path: '../inc-002-oomkilled/ground-truth.json' }), /outside incident/);
  const search = await runTool(INC, 'search_artifacts', { pattern: 'must_mention' });
  assert.equal(search.output, 'no matches');
});

test('read_artifact numbers lines and pages', async () => {
  const r = await runTool(INC, 'read_artifact', { path: SVC, start_line: 31, end_line: 33 });
  assert.equal(r.output.split('\n')[0], '31|     @Transactional');
  assert.match(r.output, /more lines; call again with start_line=34/);
});

test('search finds a known line (positive control)', async () => {
  const r = await runTool(INC, 'search_artifacts', { pattern: 'request timed out after \\d+ms' });
  assert.ok(r.output.split('\n').length >= 3, r.output);
  assert.match(r.output, /^logs\/payment-service\.log:\d+\| /);
});

test('evidence: real quote at cited lines is verified', async () => {
  const c = await verifyEvidence(INC, { artifact: SVC, start_line: 34, end_line: 34, quote: 'FraudVerdict verdict = fraudClient.score(payment);' });
  assert.equal(c.status, 'verified');
  assert.equal(c.found_line, 34);
});

test('evidence: multi-line quote with echoed prefixes and elision is verified', async () => {
  const quote = '31|     @Transactional\n32|     public PaymentResult authorize(AuthorizeRequest req) {\n... fraudClient.score(payment);';
  assert.equal((await verifyEvidence(INC, { artifact: SVC, start_line: 31, end_line: 35, quote })).status, 'verified');
});

test('evidence: real quote with wrong line numbers is flagged misplaced', async () => {
  const c = await verifyEvidence(INC, { artifact: SVC, start_line: 2, end_line: 2, quote: 'FraudVerdict verdict = fraudClient.score(payment);' });
  assert.equal(c.status, 'misplaced');
  assert.equal(c.found_line, 34);
});

test('evidence: fabricated quote is rejected (the check can fail)', async () => {
  const c = await verifyEvidence(INC, { artifact: 'logs/payment-service.log', start_line: 15, end_line: 15, quote: 'OutOfMemoryError: Java heap space' });
  assert.equal(c.status, 'not_found');
  const m = await verifyEvidence(INC, { artifact: 'logs/does-not-exist.log', start_line: 1, end_line: 1, quote: 'anything at all' });
  assert.equal(m.status, 'missing_artifact');
});

test('patch: removals that exist apply; invented ones mismatch', async () => {
  const good = await verifyPatch(INC, {
    artifact: SVC,
    patch: '--- a/x\n+++ b/x\n@@\n     @Transactional\n-        FraudVerdict verdict = fraudClient.score(payment);\n+        // moved out\n',
  });
  assert.equal(good.status, 'applies');
  const bad = await verifyPatch(INC, { artifact: SVC, patch: '-        connection.close();\n+        // nope\n' });
  assert.equal(bad.status, 'mismatch');
  assert.deepEqual(bad.missing, ['connection.close();']);
  assert.equal((await verifyPatch(INC, { artifact: SVC, patch: '+ only additions\n' })).status, 'no_removals');
});

test('scoring: correct diagnosis passes, a red herring fails', async () => {
  const gt = await loadGroundTruth(INC);
  const right = scoreReport({
    summary: 'Hikari pool exhausted.',
    root_cause: 'The fraud-service call now runs inside the @Transactional authorize method, holding a connection.',
    fix: { artifact: SVC },
  }, gt);
  assert.equal(right.correct, true);
  assert.equal(right.fix_target_correct, true);
  const wrong = scoreReport({ summary: 'GC pauses', root_cause: 'Long G1 GC pauses caused fraud timeouts.', fix: { artifact: 'config/application.yml' } }, gt);
  assert.equal(wrong.correct, false);
  assert.equal(wrong.fix_target_correct, false);
});
