import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'incidentlens-paths-'));
process.env.INCIDENTLENS_DATA_DIR = path.join(tmp, 'data');
const { readArtifact } = await import('../src/incidents.ts');

test('a link inside a case that points outside it is refused; a real file inside is readable', async () => {
  const outside = path.join(tmp, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET\n');
  const caseDir = path.join(tmp, 'data', 'self-cases', 'self-1');
  await mkdir(path.join(caseDir, 'logs'), { recursive: true });
  await writeFile(path.join(caseDir, 'logs', 'ok.log'), 'fine\n');
  await symlink(outside, path.join(caseDir, 'escape'), 'junction');
  assert.deepEqual(await readArtifact('self-1', 'logs/ok.log'), ['fine']);
  await assert.rejects(readArtifact('self-1', 'escape/secret.txt'), /outside incident/);
});

test('without ACCESS_SECRET the server refuses to listen beyond loopback', () => {
  const r = spawnSync(process.execPath, ['src/server.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, HOST: '0.0.0.0', ACCESS_SECRET: '', INCIDENTLENS_DEV_OPEN: '', PORT: '0' },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to listen on 0\.0\.0\.0 without ACCESS_SECRET/);
});
