import { spawn } from 'node:child_process';
import path from 'node:path';
import { startRoleFake } from '../test/fixtures/warroom-script.ts';

// Offline demo: runs IncidentLens against a scripted stand-in model so the War Room, governance
// and self-repair flows can be explored without Meta Model API access. This is NOT Muse: the
// models are labelled as scripted in the UI, the script covers only inc-001, and demo state is
// kept in separate folders so it never mixes with real runs.

const ROOT = path.resolve(import.meta.dirname, '..');
const fake = await startRoleFake(800, { unknownRoleStatus: 422, onlyIncident: 'inc-001-pool-exhaustion' });
const label = (tier: string) => `scripted-${tier} (offline demo, not Muse)`;
const server = spawn(process.execPath, ['src/server.ts'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    MODEL_BASE_URL: fake.url,
    MODEL_API_KEY: 'offline-demo',
    MODEL_DEEP: label('deep'),
    MODEL_FAST: label('fast'),
    WARROOM_CONCURRENCY: '1',
    INCIDENTLENS_DATA_DIR: path.join(ROOT, 'data-offline-demo'),
    INCIDENTLENS_RUNS_DIR: path.join(ROOT, 'runs-offline-demo'),
    ACCESS_SECRET: '',
  },
});
const stop = () => {
  server.kill();
  fake.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => {
  fake.close();
  process.exit(code ?? 0);
});
