import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { revisionScript } from '../fake-model.ts';

// A scripted model that plays every War Room role on inc-001, used by the War Room test and the
// browser check. The role is read from the system prompt; each role pops its next scripted turn.
// Deterministic with concurrency 1 and a P0 live update after 4 turns.

const SVC = 'src/main/java/com/acme/payments/PaymentService.java';
const LOG = 'logs/payment-service.log';
const conclusion = {
  hypothesis_id: 'H1',
  summary: 'HikariCP connection pool exhausted because the fraud call holds DB connections.',
  root_cause: 'PR #482 moved the fraud-service HTTP call inside the @Transactional authorize() method, so each request holds a connection for the whole fraud check; ~8s fraud latency exhausted the 10-connection pool.',
  category: 'code-change',
  confidence: 0.9,
  timeline: [
    { time: '14:02', event: 'v2.14.0 deployed (PR #482)' },
    { time: '14:08', event: 'fraud-service latency rises to 4-8s' },
    { time: '14:09', event: 'Hikari pool exhausted; requests time out after 30s' },
  ],
  next_steps: ['Roll back v2.14.0', 'Add a fraud client timeout below the pool timeout'],
};
const fixArgs = (patch: string) => ({ mitigation: ['Roll back payment-service to v2.13.x'], artifact: SVC, explanation: 'Score fraud before opening the transaction so no connection is held during the HTTP call.', patch, regression_test: { name: 'authorizeDoesNotHoldConnectionDuringFraudCheck', language: 'java', code: '@Test void authorizeDoesNotHoldConnectionDuringFraudCheck() {\n  fraudClient.delay(Duration.ofSeconds(5));\n  assertThat(pool.activeDuring(() -> service.authorize(req))).isZero();\n}' } });

export const SCRIPTS: Record<string, { name: string; args: any }[][]> = {
  commander: [
    [
      { name: 'list_artifacts', args: {} },
      { name: 'create_task', args: { role: 'signals', title: 'Logs and traces', detail: 'When did pool errors start and why?', priority: 1 } },
      { name: 'create_task', args: { role: 'code', title: 'Recent changes', detail: 'Review PR #482', priority: 2 } },
      { name: 'complete_task', args: { result: 'Plan: signals P1, code P2' } },
    ],
    [
      { name: 'create_task', args: { role: 'fixer', title: 'Stop checkout failures', detail: 'Propose immediate mitigation', priority: 0, kind: 'mitigate' } },
      { name: 'complete_task', args: { result: 'Mitigation dispatched' } },
    ],
    [
      { name: 'conclude', args: conclusion },
      { name: 'complete_task', args: { result: 'Waiting for skeptic review' } },
    ],
    [{ name: 'conclude', args: conclusion }],
  ],
  signals: [
    [{ name: 'read_artifact', args: { path: LOG } }],
    [
      { name: 'post_fact', args: { claim: 'Heap OOM', artifact: LOG, start_line: 15, end_line: 15, quote: 'java.lang.OutOfMemoryError: Java heap space' } },
      { name: 'post_fact', args: { claim: 'Requests time out waiting for a Hikari connection', artifact: LOG, start_line: 15, end_line: 15, quote: 'HikariPool-1 - Connection is not available, request timed out after 30000ms' } },
    ],
    [
      { name: 'post_fact', args: { claim: 'All 10 connections active with requests waiting', artifact: LOG, start_line: 14, end_line: 14, quote: 'Pool stats (total=10, active=10, idle=0, waiting=14)' } },
      { name: 'ask_agent', args: { to: 'code', question: 'Is fraudClient.score called inside the @Transactional authorize method?', priority: 1 } },
    ],
    [
      { name: 'propose_hypothesis', args: { statement: 'PR #482 moved the fraud call inside @Transactional authorize(), holding Hikari connections during slow fraud checks', fact_ids: ['F1', 'F2'] } },
      { name: 'complete_task', args: { result: 'H1 proposed from F1, F2' } },
    ],
  ],
  code: [
    [{ name: 'read_artifact', args: { path: SVC } }],
    [
      { name: 'post_fact', args: { claim: 'fraudClient.score runs inside the transactional authorize()', artifact: SVC, start_line: 34, end_line: 34, quote: 'FraudVerdict verdict = fraudClient.score(payment);' } },
      { name: 'complete_task', args: { result: 'Yes: F3, line 34 is inside @Transactional authorize()' } },
    ],
  ],
  skeptic: [
    [
      { name: 'post_fact', args: { claim: 'GC pauses are short', artifact: LOG, start_line: 10, end_line: 10, quote: 'GC(41) Pause Young (Normal) (G1 Evacuation Pause) 412M->188M(1024M) 18.442ms' } },
      { name: 'challenge_hypothesis', args: { hypothesis_id: 'H1', verdict: 'stands', reason: 'GC pauses are 18ms; pool exhaustion tracks fraud latency', fact_ids: ['F4'] } },
    ],
  ],
  fixer: [
    [{ name: 'submit_mitigation', args: { steps: ['Roll back payment-service to v2.13.x'], rationale: 'v2.14.0 introduced the regression' } }],
    [{ name: 'read_artifact', args: { path: SVC } }],
    [{ name: 'submit_fix', args: fixArgs('-        connection.close();\n+        // invented\n') }],
    [{ name: 'submit_fix', args: fixArgs('-        FraudVerdict verdict = fraudClient.score(payment);\n+        FraudVerdict verdict = preScoredVerdict(req);\n') }],
  ],
};

// The solo investigator's script: a fabricated citation first, then the corrected report.
SCRIPTS.solo = revisionScript.map((call) => [call]);

const HEADINGS: [string, string][] = [
  ['# Solo investigator', 'solo'],
  ['# Incident commander', 'commander'],
  ['# Signals analyst', 'signals'],
  ['# Platform analyst', 'platform'],
  ['# Code analyst', 'code'],
  ['# Skeptic', 'skeptic'],
  ['# Fixer', 'fixer'],
];

export async function startRoleFake(delayMs = 0, opts: { unknownRoleStatus?: number; onlyIncident?: string } = {}) {
  const requests: { role: string; model: string; body: any }[] = [];
  const cursor: Record<string, number> = {};
  let overflow = 0;
  let seq = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const role = HEADINGS.find(([h]) => String(body.instructions).includes(h))?.[1] ?? 'unknown';
    requests.push({ role, model: body.model, body });
    if (role === 'unknown' && opts.unknownRoleStatus) {
      res.writeHead(opts.unknownRoleStatus, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'offline demo: no script for this role' } }));
    }
    const history = body.input ?? body.messages ?? [];
    if (opts.onlyIncident && !JSON.stringify(history).includes(opts.onlyIncident)) {
      res.writeHead(422, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `offline demo: the scripted model only covers ${opts.onlyIncident}` } }));
    }
    // A new session (one message so far) starts that role's script from the top.
    if (history.length === 1) cursor[role] = -1;
    const i = (cursor[role] = (cursor[role] ?? -1) + 1);
    const turn = SCRIPTS[role]?.[i];
    if (!turn) overflow++;
    const calls = turn ?? [{ name: 'complete_task', args: { result: 'script exhausted' } }];
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: calls.map((c) => ({ type: 'function_call', call_id: `c${++seq}`, name: c.name, arguments: JSON.stringify(c.args) })), usage: { input_tokens: 500, output_tokens: 50 } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, overflow: () => overflow, close: () => server.close() };
}
