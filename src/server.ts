import { createServer, type ServerResponse } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { investigate, RUNS_DIR } from './agent.ts';
import { listArtifacts, listIncidents, readArtifact } from './incidents.ts';
import { MODEL, WIRE } from './llm.ts';
import { runWarRoom } from './warroom/run.ts';

const PORT = Number(process.env.PORT ?? 5173);
const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', 'public');
const EVAL_DIR = path.resolve(import.meta.dirname, '..', 'eval');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function latestRun(id: string): Promise<any | null> {
  const dir = path.join(RUNS_DIR, id);
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort();
  // Only replay runs that produced a report.
  for (const f of files.reverse()) {
    const run = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    if (run.events.some((e: any) => e.type === 'report')) return { file: f, ...run };
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (parts[0] === 'api') {
      if (parts[1] === 'config') return json(res, 200, { model: MODEL, wire: WIRE, key: Boolean(process.env.MODEL_API_KEY) });
      if (parts[1] === 'incidents' && parts.length === 2) return json(res, 200, await listIncidents());
      if (parts[1] === 'incidents' && parts[3] === 'artifacts') return json(res, 200, await listArtifacts(parts[2]));
      if (parts[1] === 'incidents' && parts[3] === 'artifact') {
        return json(res, 200, { path: url.searchParams.get('path'), lines: await readArtifact(parts[2], url.searchParams.get('path') ?? '') });
      }
      if (parts[1] === 'runs' && parts[2]) {
        const run = await latestRun(parts[2]);
        return run ? json(res, 200, run) : json(res, 404, { error: 'no recorded run' });
      }
      if (parts[1] === 'eval') {
        const raw = await readFile(path.join(EVAL_DIR, 'latest.json'), 'utf8').catch(() => null);
        return raw ? json(res, 200, JSON.parse(raw)) : json(res, 404, { error: 'no eval run yet' });
      }
      if (parts[1] === 'investigate' && parts[2]) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        const run = url.searchParams.get('mode') === 'warroom' ? runWarRoom : investigate;
        await run(parts[2], (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
        clearInterval(ping);
        res.write('event: done\ndata: {}\n\n');
        return res.end();
      }
      return json(res, 404, { error: 'not found' });
    }

    const rel = url.pathname === '/' ? 'index.html' : path.posix.normalize(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'forbidden' });
    const body = await readFile(file).catch(() => null);
    if (!body) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch (err: any) {
    if (!res.headersSent) json(res, 400, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`IncidentLens on http://localhost:${PORT}  (model ${MODEL} via ${WIRE}${process.env.MODEL_API_KEY ? '' : ', MODEL_API_KEY NOT SET'})`);
});
