/** Source executed directly by Node in a disposable native child. */
export const childSource = String.raw`// Only fixture-owned synthetic values; never print environment values to the model.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = __dirname;
const instance = randomUUID();
const env = Object.fromEntries(['OAR_MCP_TOKEN', 'OAR_SHELL_TOKEN', 'OAR_UNLISTED_CONTROL', 'OAR_ALLOWED_CONTROL'].map(key => [key, process.env[key] ?? null]));
const record = value => fs.appendFileSync(path.join(root, 'children.jsonl'), JSON.stringify({ at: new Date().toISOString(), instance, pid: process.pid, env, ...value }) + '\n');
if (process.argv[2] === 'mcp') {
  record({ kind: 'mcp-start' });
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const q = JSON.parse(line);
    if (q.id === undefined) return;
    let result = {};
    if (q.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'scope', version: '1' } };
    if (q.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Capture environment out of band', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
    if (q.method === 'tools/call') {
      record({ kind: 'mcp-call', input: q.params.arguments.text });
      result = { content: [{ type: 'text', text: 'SYNTHETIC_MCP_CAPTURED' }] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) + '\n');
  });
} else {
  record({ kind: 'shell' });
  console.log('SYNTHETIC_SHELL_CAPTURED');
}
`;
