/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/strict-boolean-expressions -- Standalone JavaScript probe across two installed DSH ABIs; injected services are checked at runtime and no DSH type/runtime package is installed in OAR. */
/** Experimental transport over injected DSH services; deliberately no DSH imports. */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

export const name = 'oar-dsh-native-probe';
// The outer plugin must still report a missing core service rather than never activating.
export function apply(ctx, config) {
  const loader = ctx.get('loader');
  if (typeof loader?.await !== 'function') {
    process.stdout.write(`${JSON.stringify({ type: 'ready', protocol: 1, unsupported: 'loader.await is unavailable' })}\n`);
    process.stdin.resume();
    return;
  }
  // Do not make this plugin's activation depend on the barrier it observes.
  void start();
  async function start() {
    try { await loader.await(); boot(ctx, config); }
    catch (error) { process.stdout.write(`${JSON.stringify({ type: 'startup-error', error: String(error) })}\n`); }
  }
}

function user(text) {
  return Object.freeze({ id: randomUUID(), role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text })]), source: Object.freeze({ kind: 'user' }) });
}

function methods(target, names) {
  return Object.fromEntries(names.map(key => [key, typeof target?.[key] === 'function']));
}

function requireMethod(target, key, capability) {
  if (typeof target?.[key] !== 'function') {
    const error = new Error(`Native ${capability} requires ${key}(), which is unavailable`);
    error.code = 'native_method_unavailable';
    error.capability = capability;
    throw error;
  }
}

function boot(ctx, config) {
  const agents = ctx.get('agents');
  const persistence = ctx.get('sessionPersistence');
  const tools = ctx.get('tools');
  const handles = new Map();
  const releases = new Map();
  let ordinal = 0;
  const emit = (value) => process.stdout.write(`${JSON.stringify({ ordinal: ++ordinal, ...value })}\n`);
  emit({ type: 'ready', protocol: 1, imports: 'none', configuredVersion: config.version, pid: process.pid, cwd: process.cwd(),
    services: { agents: methods(agents, ['create', 'resume']), sessionPersistence: methods(persistence, ['list', 'open', 'flush']),
      tools: methods(tools, ['register']), llm: Boolean(ctx.get('llm')), sessions: Boolean(ctx.get('sessions')) } });
  ctx.on('session/event', (session, event) => emit({ type: 'native', channel: 'session/event', sessionId: session.header.id, event }));
  ctx.on('agent/assistant-stream', ({ agent, frame }) => emit({ type: 'native', channel: 'agent/assistant-stream', sessionId: agent.session.id, frame }));
  ctx.on('agent/status', ({ agent, status }) => emit({ type: 'native', channel: 'agent/status', sessionId: agent.session.id, status }));
  ctx.on('agent/error', ({ agent, error }) => emit({ type: 'native', channel: 'agent/error', sessionId: agent.session.id, error: String(error) }));
  for (const channel of ['subagent/start', 'subagent/end']) {ctx.on(channel, info => emit({ type: 'native', channel, info }));}
  if (typeof tools?.register === 'function') {tools.register({
    name: 'oar_probe_echo', description: 'Local fixture, returns its input. No filesystem changes.',
    parameters: { type: 'object', properties: { value: { type: 'string' }, hold: { type: 'boolean' } }, required: ['value'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      emit({ type: 'fixture', action: 'tool-start', args, callId: exec.callId });
      if (args.hold) {
        const { promise, resolve, reject } = Promise.withResolvers();
        const done = () => { releases.delete(args.value); exec.signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { releases.delete(args.value); reject(exec.signal.reason); };
        releases.set(args.value, done);
        if (exec.signal.aborted) { abort(); } else { exec.signal.addEventListener('abort', abort, { once: true }); }
        await promise;
      }
      emit({ type: 'fixture', action: 'tool-return', args });
      return args.value;
    },
  });}
  const requireHandle = id => {
    const handle = handles.get(id);
    if (!handle) {throw new Error(`No bridge-owned session ${id}`);}
    return handle;
  };
  async function command(request) {
    const { method, sessionId } = request;
    if (method === 'new' || method === 'resume') {
      requireMethod(agents, method === 'new' ? 'create' : 'resume', method);
      const options = { agentOptions: { provider: 'oar-probe', model: 'probe-model' } };
      const handle = method === 'new'
        ? await agents.create({ ...options, sessionId: sessionId ?? randomUUID(), meta: { cwd: request.cwd } })
        : await agents.resume({ ...options, resumeSessionId: sessionId });
      handles.set(handle.agent.session.id, handle);
      return { sessionId: handle.agent.session.id, header: handle.agent.session.header, model: handle.agent.model?.current(), methods: methods(handle.agent, ['followup', 'steer', 'inject', 'cancel']), inboxMethods: methods(handle.agent.inbox, ['remove', 'splice']), modelCurrent: typeof handle.agent.model?.current === 'function' };
    }
    if (method === 'list') { requireMethod(persistence, 'list', method); requireMethod(persistence, 'flush', method); await persistence.flush(); return await persistence.list(); }
    if (method === 'history') {
      await persistence.flush();
      const stored = await persistence.open(sessionId, 'read');
      try { return await stored.read(); } finally { await stored.close(); }
    }
    if (method === 'release') { releases.get(request.value)?.(); return { released: request.value }; }
    if (method === 'close-all') {
      await Promise.all([...handles.values()].map(handle => handle.dispose()));
      handles.clear();
      await persistence.flush();
      return {};
    }
    const handle = requireHandle(sessionId);
    if (method === 'close') { await handle.dispose(); handles.delete(sessionId); return {}; }
    if (method === 'snapshot') {return { status: handle.agent.status, nextStep: handle.agent.inbox.nextStep, nextTurn: handle.agent.inbox.nextTurn };}
    if (method === 'model-current') { requireMethod(handle.agent.model, 'current', method); return handle.agent.model.current(); }
    if (method === 'cancel') { requireMethod(handle.agent, 'cancel', method); handle.agent.cancel({ kind: 'user' }, { keepInbox: request.keepInbox ?? false }); return {}; }
    if (method === 'withdraw') { requireMethod(handle.agent.inbox, 'remove', method); return { removed: handle.agent.inbox.remove(request.messageId) }; }
    if (['prompt', 'steer', 'inject', 'queue'].includes(method)) {
      const message = user(request.text);
      if (method === 'prompt' || method === 'queue') { requireMethod(handle.agent, 'followup', method); handle.agent.followup(message); }
      else {
        requireMethod(handle.agent, method, method);
        handle.agent[method](message);
      }
      return { messageId: message.id };
    }
    throw new Error(`Unknown method ${method}`);
  }
  const input = createInterface({ input: process.stdin });
  input.on('line', line => { void receive(line); });
  async function receive(line) {
    let request = null;
    try { request = JSON.parse(line); }
    catch (error) { emit({ type: 'protocol-error', error: String(error) }); return; }
    try { emit({ type: 'response', id: request.id, result: await command(request) }); }
    catch (error) { emit({ type: 'response', id: request.id, error: String(error), code: error?.code, capability: error?.capability, stack: error?.stack }); }
  }
  ctx.effect(() => () => input.close());
}
