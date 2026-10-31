/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/strict-boolean-expressions, typescript/promise-function-async, eslint/max-statements, eslint/max-lines-per-function, promise/avoid-new, promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- Standalone untyped ACP adversarial wire fixture, with independent reply scheduling and raw native payloads. */
import readline from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';

const sessions = new Map();
const requests = new Map();
const lateNewReplies = new Map();
let nextSession = 0;
let nextRequest = 0;
let initialized = 0;
let resumes = 0;
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const result = (id, value) => send({ id, result: value });
const update = (sessionId, text) => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const host = (method, params) => new Promise((resolve, reject) => {
  const id = `host-${++nextRequest}`;
  requests.set(id, { resolve, reject }); send({ id, method, params });
});
async function handle(message) {
  if (!('method' in message)) {
    const pending = requests.get(message.id); requests.delete(message.id);
    if (message.error) { pending?.reject(new Error(message.error.message)); } else { pending?.resolve(message.result); }
    return;
  }
  const { id, method, params = {} } = message;
  if (process.env.FIXTURE_TRACE_FILE) { appendFileSync(process.env.FIXTURE_TRACE_FILE, `${JSON.stringify({ pid: process.pid, method })}\n`); }
  if (method === 'initialize') {
    initialized++;
    if (process.env.FAIL_INIT === '1') { send({ id, error: { code: -32_000, message: 'initialize refused' } }); return; }
    const version = process.env.FIXTURE_AGENT_VERSION_FILE ? readFileSync(process.env.FIXTURE_AGENT_VERSION_FILE, 'utf8') : process.env.FIXTURE_AGENT_VERSION;
    result(id, { protocolVersion: 1, ...(version ? { agentInfo: { name: 'fixture', version } } : {}), agentCapabilities: { ...(process.env.FIXTURE_HTTP_MCP === "1" ? { mcpCapabilities: { http: true } } : {}), loadSession: true, sessionCapabilities: { resume: {}, close: {} } } });
  } else if (method === 'session/new') {
    const sessionId = `root-${++nextSession}`;
    const collision = /(?:late-)?collision-(?<id>root-\d+)$/u.exec(params.cwd)?.groups?.id;
    if (collision) {
      if (params.cwd.includes('late-collision')) { lateNewReplies.set(id, () => result(id, { sessionId: collision })); }
      else { result(id, { sessionId: collision }); }
      return;
    }
    sessions.set(sessionId, { ...params, pending: null, ignore: false });
    update(sessionId, `early:${sessionId}`);
    send({ method: 'fixture/usage', params: { sessionId, key: 'before-open' } });
    let delay = nextSession === 1 ? 30 : 0;
    if (params.cwd.endsWith("slow-new")) { delay = 500; }
    const answer = () => { result(id, { sessionId, pid: process.pid, initialized, cwd: params.cwd, servers: params.mcpServers.map(s => s.name) }); send({ method: 'fixture/usage', params: { sessionId, key: 'after-open' } }); };
    if (params.cwd.endsWith('late-new')) { lateNewReplies.set(id, answer); }
    else { setTimeout(answer, delay); }
  } else if (method === '$/cancel_request') {
    const answer = lateNewReplies.get(params.requestId); lateNewReplies.delete(params.requestId);
    if (answer) { answer(); }
  } else if (method === 'session/resume' || method === 'session/load') {
    resumes++;
    if (params.cwd.endsWith('resume-failure')) { send({ id, error: { code: -32_000, message: 'native resume refused' } }); return; }
    sessions.set(params.sessionId, { ...params, pending: null, ignore: false }); update(params.sessionId, 'resume-replay'); result(id, { pid: process.pid, initialized });
  } else if (method === 'session/close') {
    const session = sessions.get(params.sessionId);
    if (session?.pending) { result(session.pending, { stopReason: 'cancelled' }); }
    if (session?.mcpServers?.length) { const values = session.mcpServers.flatMap(s => s.env ?? []); for (const value of values) { if (value.name === 'API_KEY') { sessions.retiredSecret = value.value; } } }
    sessions.delete(params.sessionId); result(id, {});
  } else if (method === 'session/cancel') {
    const session = sessions.get(params.sessionId);
    if (session?.pending && !session.ignore) { result(session.pending, { stopReason: 'cancelled' }); session.pending = null; }
  } else if (method === 'session/prompt') {
    const session = sessions.get(params.sessionId);
    if (!session) { throw new Error('unknown native session'); }
    const text = params.prompt[0]?.text;
    // The test-only output relay exits on this marker. This agent keeps stdin
    // open and stays alive, independent of platform-specific stdout handles.
    if (text === 'connection-break') {
      send({ method: 'fixture/break-output' });
      return;
    }
    if (text === 'exit') { process.exit(7); }
    if (text === 'late-host-after-release') {
      session.pending = id; session.ignore = true;
      setTimeout(() => { void (async () => {
        try { await host('terminal/create', { sessionId: params.sessionId, command: process.execPath, args: ['-e', "require('node:fs').writeFileSync('must-not-exist', 'started')"] }); update(params.sessionId, 'late-host-allowed'); }
        catch { update(params.sessionId, 'late-host-refused'); }
        result(id, { stopReason: 'end_turn' }); session.pending = null;
      })(); }, 200);
      return;
    }
    if (text === 'hold' || text === 'ignore-cancel' || text === 'late-after-release') { session.pending = id; session.ignore = text !== 'hold'; if (text === 'late-after-release') { setTimeout(() => { update(params.sessionId, 'late-native-text'); result(id, { stopReason: 'end_turn' }); session.pending = null; }, 150); } return; }
    if (text === 'raw-update') {
      send({ method: 'session/update', params: { sessionId: params.sessionId, vendorOuter: 'kept', update: { sessionUpdate: 'tool_call', toolCallId: 'raw-tool', title: 'Read', vendorTool: 42 } } });
      send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'raw-tool', status: 'completed' } } });
      send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'usage_update', used: 250, size: 1000, vendorUsage: true } } });
    } else if (text === 'cancelled-host') {
      const requestId = `host-${++nextRequest}`;
      const answered = new Promise((resolve) => { requests.set(requestId, { resolve, reject: resolve }); });
      send({ id: requestId, method: 'terminal/create', params: { sessionId: params.sessionId, command: process.execPath, args: ['-e', "require('node:fs').writeFileSync('cancelled-host-started', 'yes')"] } });
      send({ method: '$/cancel_request', params: { requestId } });
      send({ method: 'fixture/cancel-observed', params: { sessionId: params.sessionId } });
      await answered;
      update(params.sessionId, 'cancelled-host-sent');
    } else if (text === 'permission') {
      const answer = await host('session/request_permission', { sessionId: params.sessionId, toolCall: { toolCallId: `call-${params.sessionId}`, title: 'permission' }, options: [{ optionId: `allow-${params.sessionId}`, kind: 'allow_once', name: 'Allow' }] });
      update(params.sessionId, JSON.stringify(answer));
    } else if (text === 'terminal') {
      const program = `require('node:fs').writeFileSync('terminal-${params.sessionId}.pid', String(process.pid)); setInterval(() => {}, 1000)`;
      const answer = await host('terminal/create', { sessionId: params.sessionId, command: process.execPath, args: ['-e', program] });
      session.terminal = answer.terminalId; update(params.sessionId, `terminal:${answer.terminalId}`);
    } else if (text === 'terminal-peer') {
      const peer = [...sessions.entries()].find(([key]) => key !== params.sessionId);
      try { await host('terminal/output', { sessionId: params.sessionId, terminalId: peer?.[1].terminal }); update(params.sessionId, 'stolen'); }
      catch { update(params.sessionId, 'peer-terminal-refused'); }
    } else if (text === 'session-count') { update(params.sessionId, `count:${sessions.size}`);
    } else if (text === 'resume-count') { update(params.sessionId, `resume-count:${resumes}`);
    } else if (text === 'child') {
      update(`${params.sessionId}-grandchild`, 'grandchild-first');
      send({ method: 'fixture/lineage', params: { sessionId: `${params.sessionId}-child`, child: `${params.sessionId}-grandchild` } });
      send({ method: 'fixture/lineage', params: { sessionId: params.sessionId, child: `${params.sessionId}-child` } });
      const child = `${params.sessionId}-child`;
      const answer = await host('session/request_permission', { sessionId: child, toolCall: { toolCallId: `call-${child}`, title: 'child permission' }, options: [{ optionId: `allow-${child}`, kind: 'allow_once', name: 'Allow' }] });
      update(child, JSON.stringify(answer));
      const terminal = await host('terminal/create', { sessionId: child, command: process.execPath, args: ['-e', 'process.exit(0)'] });
      await host('terminal/release', { sessionId: child, terminalId: terminal.terminalId });
    } else if (text === 'unowned-host') {
      try { await host('terminal/create', { sessionId: 'unowned', command: process.execPath, args: ['-e', 'throw new Error("must not run")'] }); update(params.sessionId, 'unexpected-allowed'); }
      catch { update(params.sessionId, 'unowned-refused'); }
    } else if (text.startsWith('peer-secret')) {
      const secret = [...sessions.values()].flatMap(s => s.mcpServers ?? []).flatMap(s => s.env ?? []).filter(e => e.name === 'API_KEY').toSorted((a, b) => b.value.length - a.value.length)[0]?.value ?? sessions.retiredSecret ?? '';
      if (text === 'peer-secret-error') { send({ id, error: { code: -32_000, message: `native error ${secret}`, data: { reason: secret } } }); return; }
      if (text === 'peer-secret-malformed') { send({ method: 'session/update', params: { sessionId: params.sessionId, update: null, secret } }); }
      else { update(params.sessionId, secret); send({ method: 'unrecognized', params: { secret } }); }

    } else { update(params.sessionId, `echo:${text}:${session.cwd}`); }
    result(id, { stopReason: 'end_turn', pid: process.pid });
  } else if (id !== undefined) { result(id, {}); }
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => { const message = JSON.parse(line); void handle(message).catch(error => send({ id: message.id, error: { code: -32_000, message: error.message } })); });
lines.on('close', () => process.exit(0));
