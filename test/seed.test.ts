import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'incidentlens-seed-'));
process.env.INCIDENTLENS_DATA_DIR = path.join(tmp, 'data');
process.env.INCIDENTLENS_RUNS_DIR = path.join(tmp, 'runs');
delete process.env.MODEL_API_KEY;
const { seedRegression, runDoctor } = await import('../src/heal/doctor.ts');
const { health } = await import('../src/heal/health.ts');
const { getRegistry } = await import('../src/skills/registry.ts');
const { getChange } = await import('../src/governance/changes.ts');

test('seeded regression: labelled synthetic runs breach, self-repair rolls back through a pre-authorized change request', async () => {
  const healthyBefore = await health();
  assert.equal(healthyBefore.sufficient, false, 'no runs yet: never a breach');

  const seeded = await seedRegression();
  assert.deepEqual([seeded.skill, seeded.version, seeded.runs], ['solo', 2, 5]);
  const h = await health();
  assert.equal(h.synthetic_runs, 5);
  assert.equal(h.healthy, false);

  const events = await runDoctor(() => {});
  const rb = events.find((e) => e.phase === 'rollback')!;
  assert.ok(rb, JSON.stringify(events));
  const cr = (await getChange(rb.change))!;
  assert.deepEqual([cr.kind, cr.state, cr.decisions[0].actor], ['skill-rollback', 'completed', 'policy']);
  assert.match(cr.rule!, /R-PREAUTH/);
  assert.equal((await getRegistry()).view().get('solo')!.version, 1);
});
