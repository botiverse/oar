// oxlint-disable -- Standalone untyped process fixture deliberately emits valid and malformed native protocol replies.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (process.env.FAKE_QWEN_SKILLS_TRACE) appendFileSync(process.env.FAKE_QWEN_SKILLS_TRACE, JSON.stringify(frame) + '\n');
  if (frame.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }) + '\n');
    continue;
  }
  if (frame.method !== 'qwen/status/workspace/skills') process.exit(8);
  const mode = process.env.FAKE_QWEN_SKILLS_MODE;
  if (mode === 'hang') continue;
  if (mode === 'exit') process.exit(1);
  const error = mode === 'unsupported' ? -32601 : mode === 'error' ? -32603 : undefined;
  const result = JSON.parse(process.env.FAKE_QWEN_SKILLS_RESULT ?? JSON.stringify({ v: 1, initialized: true, workspaceCwd: process.cwd(), skills: [] }));
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...(error === undefined ? { result } : { error: { code: error, message: 'PRIVATE_NATIVE_ERROR', data: { token: 'PRIVATE_TOKEN' } } }) }) + '\n');
}
