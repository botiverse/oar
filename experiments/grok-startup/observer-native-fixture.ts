import { createInterface } from 'node:readline';

const scenario = process.env.SCENARIO;
process.stderr.write('fixture-ready\n');
const reader = createInterface({ input: process.stdin });
reader.on('line', line => {
  const frame: unknown = JSON.parse(line);
  if (typeof frame !== "object" || frame === null || !("method" in frame) || !("id" in frame)) { throw new Error("invalid synthetic request"); }
  if (scenario === frame.method) {
    process.stderr.write('fixture-stalled\n');
    return;
  }
  if (scenario === 'exit' && frame.method === 'authenticate') {
    process.stderr.write('auth failed synthetic-auth-secret-');
    process.stderr.write('123456789\nlast diagnostic without newline', () => process.exit(23));
    return;
  }
  if (scenario === 'flood' && frame.method === 'initialize') {
    process.stdout.write('not-json\n'.repeat(3000));
    process.stdout.write(`${'x'.repeat(1024 * 1024 + 10)}\n`);
  }
  if (scenario === 'multibyte-line' && frame.method === 'initialize') { process.stdout.write(`${'🙂'.repeat(300_000)}\n`); }
  if (frame.method === 'session/prompt') {
    process.stderr.write('mcp synthetic-mcp-secret-123456789\n');
    process.stdout.write(`${JSON.stringify({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', private: 'private-output' } } })}\n`);
  }
  // Split a frame across writes, without changing its bytes.
  const answer = `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { private: 'private-result' } })}\n`;
  process.stdout.write(answer.slice(0, 12));
  process.stdout.write(answer.slice(12));
});
