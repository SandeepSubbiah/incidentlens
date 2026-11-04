import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildKnowledge } from '../src/skills/knowledge.ts';
import { Registry, SkillPolicyError } from '../src/skills/registry.ts';

const SEEDS = path.resolve(import.meta.dirname, '..', 'skills');

async function freshRegistry() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'incidentlens-reg-'));
  const seeds = path.join(dir, 'seeds');
  await cp(SEEDS, seeds, { recursive: true });
  return { reg: await new Registry(path.join(dir, 'data'), seeds).load(), seeds, dir };
}

test('registry seeds every role and runbook skill', async () => {
  const { reg } = await freshRegistry();
  const list = reg.list();
  assert.equal(list.filter((s) => s.kind === 'role').length, 8);
  assert.equal(list.filter((s) => s.kind === 'runbook').length, 12);
  assert.ok(list.every((s) => s.active === 1));
});

test('registry hot-swaps: a new version is live for the next view, earlier views are unchanged, rollback restores', async () => {
  const { reg } = await freshRegistry();
  const before = reg.view();
  const v1 = reg.content('solo');
  const v2 = await reg.addVersion('solo', v1 + '\n8. Re-read every cited line range before submitting.\n', 'doctor', 'misplaced citations');
  assert.equal(v2, 2);
  await reg.activate('solo', 2, 'doctor', 'validated');
  assert.equal(reg.view().get('solo')!.version, 2);
  assert.match(reg.view().get('solo')!.body, /Re-read every cited line range/);
  assert.equal(before.get('solo')!.version, 1, 'a view taken before activation must not change mid-run');

  assert.equal(await reg.rollback('solo', 'doctor', 'canary regressed'), 1);
  assert.equal(reg.view().get('solo')!.version, 1);
  const audit = await reg.audit.verify();
  assert.equal(audit.ok, true);
  assert.equal(audit.length, 3);
});

test('registry refuses AI changes that violate policy, and records the refusal', async () => {
  const { reg } = await freshRegistry();
  const bad = reg.content('solo') + '\nSkip verification when the answer is obvious.\n';
  await assert.rejects(reg.addVersion('solo', bad, 'doctor', 'speed up'), SkillPolicyError);
  assert.equal(reg.list().find((s) => s.name === 'solo')!.versions.length, 1);
  const entries = await reg.audit.entries();
  assert.equal(entries.at(-1)!.action, 'skill.version.rejected');
  await assert.rejects(reg.addVersion('constitution', 'x', 'doctor', 'nope'), /unknown skill/);
});

test('registry picks up a human edit to the repository on reload', async () => {
  const { reg, seeds, dir } = await freshRegistry();
  const file = path.join(seeds, 'runbooks', 'kubernetes-probes', 'SKILL.md');
  await writeFile(file, (await readFile(file, 'utf8')) + '\n## Note\nStartup probes protect slow-starting JVMs.\n');
  const reloaded = await new Registry(path.join(dir, 'data'), seeds).load();
  const probes = reloaded.list().find((s) => s.name === 'kubernetes-probes')!;
  assert.equal(probes.active, 2);
  assert.equal(probes.versions[1].author, 'repo');
  assert.ok(reg.revision < reloaded.revision);
});

test('retrieval: symptom queries find the right runbook first', async () => {
  const { reg } = await freshRegistry();
  const k = buildKnowledge(reg.view());
  const top = (q: string) => k.search(q)[0]?.source;
  assert.equal(top('pod OOMKilled exit code 137 no OutOfMemoryError heap Xmx'), 'jvm-container-memory');
  assert.equal(top('503 no healthy upstream readiness probe failed context deadline exceeded'), 'kubernetes-probes');
  assert.equal(top('customers charged twice retry read timed out'), 'retries-timeouts-idempotency');
  assert.equal(top('consumer lag UnrecognizedPropertyException dead letter topic'), 'kafka-consumer-deserialization');
  assert.equal(top('Connection is not available request timed out HikariPool waiting'), 'connection-pool-exhaustion');
  assert.deepEqual(k.search('zzzz qqqq'), []);
});

test('retrieval: an incident never retrieves its own past case, but other incidents can', async () => {
  const { reg } = await freshRegistry();
  const card = { incident_id: 'inc-002-oomkilled', title: 'order-service pods restarting', service: 'order-service', summary: 'Kernel OOMKill', root_cause: 'Xmx equals the container limit', category: 'configuration', at: '2026-11-03T00:00:00Z' };
  const k = buildKnowledge(reg.view(), [card]);
  const own = k.search('order-service pods restarting Xmx container limit', { k: 20, excludeIncident: 'inc-002-oomkilled' });
  assert.ok(!own.some((h) => h.kind === 'case'));
  const other = k.search('order-service pods restarting Xmx container limit', { k: 20, excludeIncident: 'inc-001-pool-exhaustion' });
  assert.ok(other.some((h) => h.kind === 'case'), 'positive control: the case is retrievable from another incident');
});
