import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// A scripted stand-in for the Meta Model API, speaking either wire format, so the agent loop
// (tool execution, verification, rejection and revision) can be tested without network access.

export interface ScriptedCall {
  name: string;
  args: any;
}

export async function startFakeModel(script: ScriptedCall[]) {
  const requests: any[] = [];
  let turn = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ url: req.url, body });
    const call = script[turn++];
    res.writeHead(200, { 'content-type': 'application/json' });
    const id = `call_${turn}`;
    if (req.url === '/v1/responses') {
      res.end(JSON.stringify({
        output: [{ type: 'function_call', call_id: id, name: call.name, arguments: JSON.stringify(call.args) }],
        usage: { input_tokens: 100, output_tokens: 10 },
      }));
    } else {
      res.end(JSON.stringify({
        content: [{ type: 'tool_use', id, name: call.name, input: call.args }],
        usage: { input_tokens: 100, output_tokens: 10 },
      }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}

const SVC = 'src/main/java/com/acme/payments/PaymentService.java';

const baseReport = {
  summary: 'HikariPool exhausted because the fraud call holds a DB connection.',
  root_cause: 'PR #482 moved fraudClient.score() inside the @Transactional authorize() method; fraud latency of ~8s held all 10 connections.',
  category: 'code-change',
  confidence: 0.9,
  timeline: [{ time: '14:02', event: 'v2.14.0 deployed' }],
  ruled_out: [{ hypothesis: 'GC pauses', reason: 'pauses are under 35ms' }],
  fix: {
    artifact: SVC,
    explanation: 'Score fraud before opening the transaction.',
    patch: '-        FraudVerdict verdict = fraudClient.score(payment);\n+        // fraud scored before the transaction\n',
  },
  regression_test: { name: 'authorizeDoesNotHoldConnectionDuringFraudCall', language: 'java', code: '@Test void x() {}' },
  next_steps: ['Roll back v2.14.0'],
};

export const goodEvidence = [
  { artifact: SVC, start_line: 34, end_line: 34, quote: 'FraudVerdict verdict = fraudClient.score(payment);', supports: 'fraud call inside tx' },
  { artifact: SVC, start_line: 31, end_line: 31, quote: '@Transactional', supports: 'method is transactional' },
];

// Turn 3 submits a fabricated quote; turn 4 corrects it after the verifier rejects it.
export const revisionScript: ScriptedCall[] = [
  { name: 'list_artifacts', args: {} },
  { name: 'read_artifact', args: { path: SVC } },
  {
    name: 'submit_report',
    args: { ...baseReport, evidence: [goodEvidence[0], { artifact: 'logs/payment-service.log', start_line: 3, end_line: 3, quote: 'java.lang.OutOfMemoryError: Java heap space', supports: 'invented' }] },
  },
  { name: 'submit_report', args: { ...baseReport, evidence: goodEvidence } },
];
