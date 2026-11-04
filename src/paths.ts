import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

// Read lazily so tests can point state at a temp directory before first use.
export const dataDir = () => process.env.INCIDENTLENS_DATA_DIR ?? path.join(ROOT, 'data');
