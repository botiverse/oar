/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/no-misused-promises, typescript/strict-void-return, typescript/strict-boolean-expressions, typescript/no-unnecessary-condition, typescript/promise-function-async, promise/avoid-new, eslint/no-await-in-loop -- Standalone upstream reproduction: untyped native JSON, event-driven child lifecycle and deliberately serialized prompts. */
// CodeBuddy native ACP reproduction, Linux + bubblewrap.
// Usage: node codebuddy-acp-consecutive-prompts.mjs /absolute/path/to/codebuddy [delay-ms]
// No OAR, external model service, account, or real credential is used.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.argv[2]) {throw new Error('Pass the absolute CodeBuddy executable path');}
const binary = realpathSync(process.argv[2]);
const delayMs = Number(process.argv[3] ?? 0);
if (!Number.isFinite(delayMs) || delayMs < 0) {throw new Error('delay-ms must be nonnegative');}
const temporaryHome = mkdtempSync(join(tmpdir(), 'codebuddy-native-repro-'));
const nativeHome = homedir();
const prompts = ['Reply one short word, no tools.', 'Reply a second short word, no tools.'];
const requests = [];
let results = 0;
const stopReasons = [];
const updates = [];
const errors = [];
let initialized = false;
let timedOut = false;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) {chunks.push(chunk);}
  let body = null;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { response.writeHead(400).end(); return; }
  if (request.url?.includes('count_tokens')) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ input_tokens: 12 }));
    return;
  }
  if (!request.url?.endsWith('/chat/completions')) { response.writeHead(404).end(); return; }
  const lastUser = body.messages?.findLast((message) => message.role === 'user');
  const userText = typeof lastUser?.content === 'string'
    ? lastUser.content : (lastUser?.content ?? []).map((part) => part.text ?? '').join('');
  let prompt = 'unknown';
  if (userText.includes(prompts[0])) { prompt = 'first'; }
  if (userText.includes(prompts[1])) { prompt = 'second'; }
  const number = requests.length + 1;
  const title = body.messages?.some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('Generate a concise, sentence-case title')) === true;
  requests.push({ number, prompt, purpose: title ? 'title' : 'conversation', model: body.model, stream: body.stream === true });
  const output = title ? 'Short local response' : `LOCAL_REPLY_${prompt.toUpperCase()}`;
  const usage = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 };
  if (!body.stream) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: `local_${number}`, object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: output }, finish_reason: 'stop' }], usage }));
    return;
  }
  response.setHeader('content-type', 'text/event-stream');
  const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
    id: `local_${number}`, object: 'chat.completion.chunk', model: body.model,
    choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage } : {}),
  })}\n\n`);
  send({ role: 'assistant', content: output });
  send({}, 'stop');
  response.end('data: [DONE]\n\n');
});
await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
const endpoint = `http://127.0.0.1:${server.address().port}`;
const child = spawn('bwrap', [
  '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
  '--bind', temporaryHome, nativeHome, '--ro-bind', binary, '/tmp/codebuddy',
  '--chdir', '/tmp', '--clearenv', '--setenv', 'HOME', nativeHome, '--setenv', 'PATH', '/usr/bin:/bin',
  '--setenv', 'CI', '1', '--setenv', 'BROWSER', 'true',
  '--setenv', 'CODEBUDDY_API_KEY', 'synthetic-local-fixture', '--setenv', 'CODEBUDDY_BASE_URL', endpoint,
  '/tmp/codebuddy', '--acp', '--permission-mode', 'bypassPermissions', '--model', 'deepseek-flash',
], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
const stop = () => {
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref();
};
const timer = setTimeout(() => { timedOut = true; stop(); }, 60_000);
const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
let sequence = 0;
const pending = new Map();
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject, method });
  send({ jsonrpc: '2.0', id, method, params });
});
child.stdin.on('error', () => {});
child.stderr.resume();
createInterface({ input: child.stdout }).on('line', (line) => {
  let frame = null;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.method === 'session/update') {
    updates.push(frame.params?.update?.sessionUpdate ?? 'unknown');
  }
  if (frame.method && frame.id !== undefined) {
    if (frame.method === 'session/request_permission') {
      const option = frame.params?.options?.find((x) => x.kind === 'allow_once');
      send({ jsonrpc: '2.0', id: frame.id, result: { outcome: option
        ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
    } else {
      send({ jsonrpc: '2.0', id: frame.id, error: { code: -32_601, message: 'Unsupported local fixture method' } });
    }
    return;
  }
  const active = pending.get(frame.id);
  if (!active) {return;}
  pending.delete(frame.id);
  if (frame.error) {
    errors.push({ method: active.method, code: frame.error.code });
    active.reject(new Error('native RPC failed'));
  } else {active.resolve(frame.result);}
});
const exited = new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    for (const value of pending.values()) {value.reject(new Error('process exited'));}
    resolve({ exitCode: code, signal });
  });
});
try {
  await request('initialize', { protocolVersion: 1, clientInfo: { name: 'native-consecutive-probe', version: '1' },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  initialized = true;
  const opened = await request('session/new', { cwd: '/tmp', mcpServers: [] });
  for (let index = 0; index < prompts.length; index++) {
    if (index > 0 && delayMs > 0) {await new Promise((resolve) => { setTimeout(resolve, delayMs); });}
    const answer = await request('session/prompt', { sessionId: opened.sessionId,
      prompt: [{ type: 'text', text: prompts[index] }] });
    results++;
    stopReasons.push(answer?.stopReason ?? 'missing');
  }
  // Catch any unsolicited duplicate provider call after the second response.
  await new Promise((resolve) => { setTimeout(resolve, 1000); });
} catch { /* only safe method/code diagnostics are published */ }
finally {
  child.stdin.end();
  stop();
  const exit = await exited;
  await new Promise((resolve) => { server.close(resolve); });
  rmSync(temporaryHome, { recursive: true, force: true });
  const conversation = requests.filter((x) => x.purpose === 'conversation').map((x) => x.prompt);
  const pass = initialized && results === 2 && stopReasons.every((x) => x === 'end_turn') && JSON.stringify(conversation) === JSON.stringify(['first', 'second']) && !timedOut && errors.length === 0;
  console.log(JSON.stringify({ pass, protocol: 'acp', delayMs, initialized, results, stopReasons, requests, updates, errors, timedOut, ...exit }, null, 2));
  if (!pass) {process.exitCode = 1;}
}
