/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/no-misused-promises, typescript/strict-void-return, typescript/strict-boolean-expressions, typescript/no-unnecessary-condition, typescript/promise-function-async, promise/avoid-new, eslint/no-await-in-loop -- Standalone upstream reproduction: untyped native JSON, event-driven child lifecycle and deliberately serialized prompts. */
// CodeBuddy native stream-json reproduction, Linux + bubblewrap.
// Usage: node codebuddy-stream-response-delay.mjs /absolute/path/to/codebuddy [input-delay-ms] [provider-reply-delay-ms]
// No OAR, external model service, account, or real credential is used.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

if (!process.argv[2]) {throw new Error('Pass the absolute CodeBuddy executable path');}
const binary = realpathSync(process.argv[2]);
const delayMs = Number(process.argv[3] ?? 0);
const replyDelayMs = Number(process.argv[4] ?? 0);
if (!Number.isFinite(delayMs) || delayMs < 0) {throw new Error('delay-ms must be nonnegative');}
const temporaryHome = mkdtempSync(join(tmpdir(), 'codebuddy-native-repro-'));
const nativeHome = homedir();
const prompts = ['Reply one short word, no tools.', 'Reply a second short word, no tools.'];
const requests = [];
let results = 0;
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
  requests.push({ number, prompt });
  await new Promise((resolve) => { setTimeout(resolve, replyDelayMs); });
  const output = `LOCAL_REPLY_${number}`;
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
const sessionId = randomUUID();
const child = spawn('bwrap', [
  '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
  '--bind', temporaryHome, nativeHome, '--ro-bind', binary, '/tmp/codebuddy',
  '--chdir', '/tmp', '--clearenv', '--setenv', 'HOME', nativeHome, '--setenv', 'PATH', '/usr/bin:/bin',
  '--setenv', 'CI', '1', '--setenv', 'BROWSER', 'true',
  '--setenv', 'CODEBUDDY_API_KEY', 'synthetic-local-fixture', '--setenv', 'CODEBUDDY_BASE_URL', endpoint,
  '/tmp/codebuddy', '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
  '--include-partial-messages', '--permission-mode', 'bypassPermissions', '--model', 'deepseek-flash',
  '--session-id', sessionId,
], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
const stop = () => {
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref();
};
const timer = setTimeout(() => { timedOut = true; stop(); }, 60_000);
const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
const prompt = (text) => send({ type: 'user', uuid: randomUUID(), session_id: sessionId,
  message: { role: 'user', content: [{ type: 'text', text }] } });
child.stdin.on('error', () => {});
// Consume stderr without publishing potentially private native diagnostic fields.
child.stderr.resume();
createInterface({ input: child.stdout }).on('line', (line) => {
  let frame = null;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.type === 'control_response') {
    if (frame.response?.request_id === 'initialize' && frame.response?.subtype === 'success') {
      initialized = true;
      prompt(prompts[0]);
    }
    return;
  }
  if (frame.type === 'control_request' && frame.request?.subtype === 'can_use_tool') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
      response: { allowed: true } } });
    return;
  }
  if (frame.type !== 'result') {return;}
  results++;
  if (results === 1) {setTimeout(() => prompt(prompts[1]), delayMs);}
  else { child.stdin.end(); setTimeout(stop, 1000).unref(); }
});
await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    console.log(JSON.stringify({ delayMs, replyDelayMs, initialized, results, requests, timedOut, exitCode: code, signal }, null, 2));
    resolve();
  });
  send({ type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize', hasPrompt: true } });
}).finally(async () => {
  stop();
  await new Promise((resolve) => { server.close(resolve); });
  rmSync(temporaryHome, { recursive: true, force: true });
});
