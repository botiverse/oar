/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/strict-boolean-expressions, typescript/strict-void-return, typescript/promise-function-async, eslint/no-await-in-loop, promise/avoid-new -- Standalone native wire observer. The untyped frames are the data under test. Each scenario sequences real process, HTTP and socket events. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as pause } from "node:timers/promises";

const [scenario, output, executable] = process.argv.slice(2);
if (!scenario || !output || !executable) {
  throw new Error("Usage: node probe.mjs SCENARIO NEW_OUTPUT.jsonl /absolute/path/to/kimi");
}
const bin = path.resolve(executable);
await writeFile(output, "", { flag: "wx" });
const dir = await mkdtemp(path.join(tmpdir(), "kap409-"));
const cwd = path.join(dir, "project"),
  home = path.join(dir, "home"),
  state = path.join(home, "kimi");
await Promise.all([mkdir(cwd), mkdir(state, { recursive: true }), mkdir(path.join(dir, "extra"))]);
let child = null,
  exitWait = null,
  n = 0,
  providerCalls = 0,
  request = 0,
  runningHold = null,
  session = null,
  socket = null,
  socketNum = 0,
  step = "initial",
  web = null;
const secrets = [];
const frames = [];
const knownUrls = [];
const aborters = [];
// Keep local Web UI credentials in memory and normalize fixture paths before writing.
const start = performance.now();
function record(type, data) {
  let encoded = JSON.stringify(
    { n: ++n, ms: Math.round(performance.now() - start), step, type, ...data },
    (k, v) => (/^(?:authorization|api_key|access_token|refresh_token|token)$/iu.test(k) ? "<redacted>" : v),
  );
  for (const t of secrets) {
    if (t) {
      encoded = encoded.replaceAll(t, "<redacted>");
    }
  }
  encoded = encoded
    .replaceAll(dir, "<PROBE>")
    .replaceAll(process.env.HOME ?? "/nonexistent/private-home", "<HOST_HOME>");
  for (const [original, replacement] of knownUrls) {
    encoded = encoded.replaceAll(original, replacement);
  }
  appendFileSync(output, `${encoded}\n`);
}
const latch = () => Promise.withResolvers();
async function until(fn, limit = 9000) {
  const due = performance.now() + limit;
  while (performance.now() < due) {
    const v = await fn();
    if (v) {
      return v;
    }
    await pause(20);
  }
  throw new Error(`no observation before deadline in ${step}`);
}
async function timeout(ms) {
  await pause(ms, null, { ref: false });
  throw new Error(`timeout in ${step}`);
}
const bounded = (promise, ms = 30_000) => Promise.race([promise, timeout(ms)]);
const env = Object.fromEntries(
  ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "LANG"]
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]]),
);
const markers = /\bW409_[A-Z0-9_]+\b/gu;
// The native CLI sees an OpenAI-compatible loopback provider. Only this fixture chooses its replies.
const packet = (d, r = null) =>
  `data: ${JSON.stringify({
    id: "fixture",
    object: "chat.completion.chunk",
    model: "fixture",
    choices: [{ index: 0, delta: d, finish_reason: r }],
  })}\n\n`;
const provider = createServer(async (req, res) => {
  try {
    const parts = [];
    for await (const b of req) {
      parts.push(b);
    }
    const body = JSON.parse(Buffer.concat(parts));
    const messages = body.messages ?? [],
      tools = (body.tools ?? []).map((x) => x.function);
    const last =
      messages
        .filter((m) => m.role === "user")
        .flatMap((m) => JSON.stringify(m.content).match(markers) ?? [])
        .at(-1) ?? "";
    const replies = messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    const toolName = {
      W409_TOOL: "Read",
      W409_BADTOOL: "Read",
      W409_CHILD: "Agent",
      W409_CHILDBG: "Agent",
      W409_CHILDWORK: "Read",
      W409_BG: "Bash",
      W409_SHELL: "Bash",
      W409_SHUT_SHELL: "Bash",
      W409_ENVDIFF: "Bash",
      W409_ENV: "Bash",
      W409_ASK: "AskUserQuestion",
      W409_APPROVE: "Write",
      W409_DENY: "Write",
    }[last];
    const tool =
      toolName && !replies.includes(`call_${last}`) ? tools.find((t) => t.name === toolName) : null;
    const row = {
      fixtureEnvKeyReceived: req.headers.authorization === "Bearer fixture-env-409",
      reasoningEffort: body.reasoning_effort ?? null,
      readListed: tools.some((t) => t.name === "Read"),
      inputMarkers: messages
        .filter((m) => m.role === "user")
        .flatMap((m) => JSON.stringify(m.content).match(markers) ?? []),
      fixtureFileHint: JSON.stringify(messages.at(-1)?.content).includes("sample.txt"),
      index: ++providerCalls,
      marker: last,
      model: body.model,
      inputRoles: messages.map((m) => m.role),
      lastParts: Array.isArray(messages.at(-1)?.content) ? messages.at(-1).content.map((p) => p.type) : [],
      replies,
      tool: tool?.name,
      vision: messages.some((m) => Array.isArray(m.content) && m.content.some((x) => x.type === "image_url")),
      summaryRequest: JSON.stringify(messages.at(-1)?.content).toLowerCase().includes("summar"),
    };
    record("provider", row);
    if (["W409_HOLD", "W409_CRASH", "W409_CHILDWORK"].includes(last) && !replies.includes(`call_${last}`)) {
      const hold = latch();
      runningHold = hold;
      aborters.push(hold);
      await Promise.race([hold.promise, pause(18_000, null, { ref: false })]);
    }
    const failure = {
      W409_FAILED: [400, "invalid_request_error", "invalid_request"],
      W409_401: [401, "authentication_error", "invalid_api_key"],
      W409_429: [429, "rate_limit_error", "rate_limit_exceeded"],
      W409_503: [503, "server_error", "service_unavailable"],
      W409_REJECTMODEL: [404, "invalid_request_error", "model_not_found"],
    }[last];
    if (failure) {
      const [status, type, code] = failure;
      res
        .writeHead(status, { "content-type": "application/json", "retry-after": "1" })
        .end(JSON.stringify({ error: { type, message: `Fixture provider ${code}`, code } }));
      return;
    }
    let args = null;
    if (tool?.name === "Read") {
      args = {
        [tool.parameters.required?.[0] ?? "path"]: path.join(
          cwd,
          last === "W409_BADTOOL" ? "missing.txt" : "sample.txt",
        ),
      };
    }
    if (tool?.name === "Write") {
      args = { path: path.join(cwd, `${last}.txt`), content: "approved fixture" };
    }
    if (tool?.name === "Bash") {
      args = {
        command: ["W409_ENV", "W409_ENVDIFF"].includes(last) ? "node env.cjs" : "node worker.cjs",
        description: "Read fixture clock",
        run_in_background: last === "W409_BG",
      };
    }
    if (tool?.name === "Agent") {
      args = {
        description: "Fixture child",
        prompt: "Read the file for W409_CHILDWORK.",
        run_in_background: last === "W409_CHILDBG",
      };
    }
    if (tool?.name === "AskUserQuestion") {
      args = {
        questions: [
          {
            header: "Color",
            question: "Select a test color",
            options: [
              { label: "Red", description: "red" },
              { label: "Blue", description: "blue" },
            ],
            multi_select: false,
          },
        ],
      };
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (tool) {
      const encoded = JSON.stringify(args);
      const cut = scenario === "toolstream" ? Math.floor(encoded.length / 2) : encoded.length;
      res.write(
        packet({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${last}`,
              type: "function",
              function: { name: tool.name, arguments: encoded.slice(0, cut) },
            },
          ],
        }),
      );
      if (cut < encoded.length) {
        await pause(70);
        res.write(packet({ tool_calls: [{ index: 0, function: { arguments: encoded.slice(cut) } }] }));
      }
      res.write(packet({}, "tool_calls"));
    } else {
      res.write(packet({ role: "assistant", reasoning_content: "Fixture " }));
      await pause(28);
      res.write(packet({ reasoning_content: "thought." }));
      await pause(28);
      res.write(packet({ content: "Alpha " }));
      await pause(22);
      res.write(packet({ content: "beta." }));
      res.write(packet({}, "stop"));
    }
    const inTokens =
      scenario === "shrink" ? Math.max(250, Math.round(JSON.stringify(messages).length / 4)) : 1234;
    res.end(
      `data: ${JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        model: "fixture",
        choices: [],
        usage: {
          prompt_tokens: inTokens,
          completion_tokens: 10,
          total_tokens: inTokens + 10,
          prompt_tokens_details: { cached_tokens: 34 },
        },
      })}\n\ndata: [DONE]\n\n`,
    );
  } catch {
    res.destroy();
  }
});
await new Promise((resolve) => {
  provider.listen(0, "127.0.0.1", resolve);
});
const base = `http://127.0.0.1:${provider.address().port}/v1`;
knownUrls.push([base, "<MODEL_URL>"]);
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  TEMP: dir,
  TMP: dir,
  TMPDIR: dir,
  XDG_CONFIG_HOME: state,
  XDG_CACHE_HOME: state,
  XDG_DATA_HOME: state,
  KIMI_CODE_HOME: state,
  KAP_PROBE_PUBLIC_LABEL: "tool-env-present",
  KIMI_DISABLE_TELEMETRY: "1",
  KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: "0",
  NO_COLOR: "1",
});
await writeFile(
  path.join(state, "config.toml"),
  `default_model = "fixture"
auto_session_title = false
[loop_control]
max_attempts_per_step = 1
[providers.local]
type = "openai"
base_url = "${base}"
api_key = "fixture-409"
[models.fixture]
provider = "local"
model = "fixture"
max_context_size = 65536
capabilities = ["image_in", "thinking"]
[models.alternate]
provider = "local"
model = "alternate"
max_context_size = 32768
capabilities = []
`,
);
await writeFile(path.join(cwd, "sample.txt"), "HELLO FROM TOOL\n");
await writeFile(
  path.join(cwd, "env.cjs"),
  "console.log(JSON.stringify({cwd:process.cwd(),label:process.env.KAP_PROBE_PUBLIC_LABEL}))",
);
await writeFile(
  path.join(cwd, "worker.cjs"),
  "require('node:fs').writeFileSync('worker.pid',String(process.pid));console.log('WORK START'); let ticks=0; const t=setInterval(()=>{console.log('tick '+ ++ticks);if(ticks>=25)clearInterval(t)},200);",
);
await mkdir(path.join(cwd, ".agents", "skills", "fixture409"), { recursive: true });
await writeFile(
  path.join(cwd, ".agents", "skills", "fixture409", "SKILL.md"),
  "---\nname: fixture409\ndescription: Fixture skill for the KAP wire test.\n---\nReturn the fixture phrase.\n",
);
if (scenario === "env") {
  Object.assign(env, {
    KIMI_MODEL_NAME: "env-wire",
    KIMI_MODEL_PROVIDER_TYPE: "openai",
    KIMI_MODEL_API_KEY: "fixture-env-409",
    KIMI_MODEL_BASE_URL: base,
    KIMI_MODEL_CAPABILITIES: "thinking,image_in",
  });
}
if (scenario === "interactions") {
  appendFileSync(
    path.join(state, "config.toml"),
    '\n[[permission.rules]]\ndecision = "ask"\npattern = "Write"\n',
  );
}
if (scenario === "account") {
  await writeFile(path.join(state, "config.toml"), "auto_session_title = false\n");
}
await mkdir(path.join(state, "skills", "home409"), { recursive: true });
await writeFile(
  path.join(state, "skills", "home409", "SKILL.md"),
  "---\nname: home409\ndescription: Read the local wire fixture.\n---\nOnly use the scripted provider.\n",
);
async function boot(processCwd = cwd) {
  const at = performance.now();
  child = spawn(bin, ["web", "--json", "--host", "127.0.0.1", "--port", "0"], {
    cwd: processCwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  exitWait = once(child, "exit");
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const [line] = await bounded(once(lines, "line"));
  lines.close();
  web = JSON.parse(line);
  assert.equal(new URL(web.origin).hostname, "127.0.0.1");
  assert.ok(web.token);
  secrets.push(web.token);
  knownUrls.push([web.origin, "<KAP_ORIGIN>"], [`ws://${new URL(web.origin).host}`, "<KAP_WS>"]);
  record("ready", { body: web, readyMs: Math.round(performance.now() - at) });
}
async function api(method, route, { body, noauth = false } = {}) {
  const id = ++request;
  const at = performance.now();
  record("http.send", { id, method, route, ...(body === undefined ? {} : { body }) });
  const r = await fetch(`${web.origin}/api/v1${route}`, {
    method,
    redirect: "error",
    headers: {
      ...(noauth ? {} : { Authorization: `Bearer ${web.token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(14_000),
  });
  const text = await r.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { bytes: text.length, mediaType: r.headers.get("content-type") };
  }
  record("http.recv", { id, status: r.status, body: payload, elapsedMs: Math.round(performance.now() - at) });
  return { http: r.status, code: payload.code, ...payload };
}
const get = (route) => api("GET", route);
const post = (route, body = {}) => api("POST", route, { body });
const sessionPath = () => `/sessions/${session}`;
async function create(opts = {}) {
  const p = await post("/sessions", { cwd, ...opts });
  assert.equal(p.code, 0, JSON.stringify(p.error));
  return p.data.id;
}
async function connect() {
  const w = new WebSocket(web.ws_url, [`kimi-code.bearer.${web.token}`]);
  const number = ++socketNum;
  socket = w;
  w.number = number;
  w.addEventListener("message", (e) => {
    const b = JSON.parse(e.data);
    frames.push({ number, b });
    record("ws.recv", { connection: number, body: b });
    if (b.type === "ping" && scenario !== "heartbeat-silent") {
      send({ type: "pong" }, w);
    }
  });
  w.addEventListener("close", (e) => {
    record("ws.close", { connection: number, code: e.code, reason: e.reason });
  });
  await bounded(
    new Promise((resolve, reject) => {
      w.addEventListener("open", resolve, { once: true });
      w.addEventListener(
        "error",
        () => {
          reject(new Error("WS open failed"));
        },
        { once: true },
      );
    }),
  );
  record("ws.open", { connection: number, protocol: "Bearer subprotocol, value redacted" });
  return w;
}
function send(b, w = socket) {
  record("ws.send", { connection: w.number, body: b });
  w.send(JSON.stringify(b));
}
function command(type, extras = {}, w = socket) {
  const id = `req${++request}`;
  send({ type, request_id: id, ...extras }, w);
  return until(() => frames.find((x) => x.number === w.number && x.b.request_id === id)?.b);
}
async function subscribe(agent = "main", w = socket) {
  const i = frames.length;
  const ack = await command("subscribe", { session_id: session, agent_ids: [agent] }, w);
  if (ack.code === 0) {
    await until(() =>
      frames
        .slice(i)
        .some(
          (x) =>
            x.number === w.number && ["turns", "turns.failed"].includes(x.b.type) && x.b.agent_id === agent,
        ),
    );
  }
  return ack;
}
async function closeWs() {
  if (socket && socket.readyState === 1) {
    const closed = once(socket, "close");
    socket.close(1000, "fixture finished");
    await bounded(closed);
  }
  socket = null;
}
async function stop() {
  const addr = web.origin;
  await closeWs();
  const at = performance.now();
  await post("/shutdown");
  const [code, signal] = await bounded(exitWait);
  child = undefined;
  let closed = false;
  try {
    await fetch(`${addr}/api/v1/meta`, { signal: AbortSignal.timeout(400) });
  } catch {
    closed = true;
  }
  record("stopped", {
    exitCode: code,
    signal,
    portClosed: closed,
    shutdownMs: Math.round(performance.now() - at),
  });
}
const hist = (agent = "main", params = "") => get(`${sessionPath()}/agents/${agent}/turns${params}`);
const wait = (ms = 9000) => post(`${sessionPath()}:wait`, { timeout_ms: ms });
const prompt = (id, more = {}) =>
  post(`${sessionPath()}/prompts`, { prompt_id: id, content: [{ type: "text", text: id }], ...more });
// :wait may also report pending interaction. The captures retain its actual reply.
async function settled() {
  const r = await wait();
  assert.equal(r.data?.timed_out, false, JSON.stringify(r));
  await pause(90);
}
async function fresh(opts) {
  session = await create(opts ?? { agent_config: { permission_mode: "yolo" } });
  await connect();
  await subscribe();
}
function goto(label) {
  step = label;
  record("case", {});
}
async function closeAll() {
  for (const h of aborters) {
    h.resolve();
  }
  await closeWs().catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await bounded(exitWait, 3000).catch(async () => {
      child.kill("SIGKILL");
      await exitWait;
    });
  }
  provider.closeAllConnections();
  await new Promise((resolve) => {
    provider.close(resolve);
  });
  await rm(dir, { recursive: true, force: true });
}

function stateOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    return { state: stat[0], startTick: stat[19] };
  } catch {
    return null;
  }
}
const cases = {
  async acpclasses() {
    child = spawn(bin, ["acp"], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    exitWait = once(child, "exit");
    const pending = new Map();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method) {
        const update = message.params?.update;
        if (update) {
          record("acp.update", { kind: update.sessionUpdate });
        }
      } else {
        pending.get(message.id)?.resolve(message);
      }
    });
    async function requestAcp(method, params) {
      const id = ++request;
      const reply = latch();
      pending.set(id, reply);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      const message = await bounded(reply.promise);
      pending.delete(id);
      if (method === "session/prompt") {
        record("acp.reply", { method, body: message });
      }
      return message;
    }
    await requestAcp("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const opened = await requestAcp("session/new", { cwd, mcpServers: [] });
    for (const marker of ["W409_401", "W409_429", "W409_503", "W409_REJECTMODEL", "W409_RECOVER"]) {
      goto(marker);
      await requestAcp("session/prompt", {
        sessionId: opened.result.sessionId,
        prompt: [{ type: "text", text: marker }],
      });
    }
    child.stdin.end();
    const [exitCode, signal] = await bounded(exitWait);
    record("stopped", { exitCode, signal });
    child = undefined;
  },
  async inventory() {
    goto("server-discovery");
    await get("/meta");
    await api("POST", "/sessions", { body: { cwd }, noauth: true });
    await api("GET", "/meta", { noauth: true });
    await get("/models");
    await get("/tools");
    await get("/capabilities");
    await get("/sessions");
    await get("/workspaces");
    goto("workspace");
    const body = {
      root: cwd,
      name: "Wire fixture",
      additional_dirs: [path.join(dir, "extra")],
      idempotency_key: "workspace409",
    };
    const reg = await post("/workspaces", body);
    await post("/workspaces", body);
    await post("/workspaces", { ...body, root: "relative" });
    assert.ok(reg.data.id);
    await get(`/workspaces/${reg.data.id}/trust`);
    await get(`/workspaces/${reg.data.id}/skills`);
    goto("create");
    await post("/sessions", {});
    await get("/sessions/session_nonexistent");
    const created = await post("/sessions", {
      workspace_id: reg.data.id,
      agent_config: { model: "fixture", thinking: "off", permission_mode: "manual" },
    });
    session = created.data.id;
    await get(sessionPath());
    await api("POST", `${sessionPath()}/prompts`, {
      body: { content: [{ type: "text", text: "W409_UNAUTH" }] },
      noauth: true,
    });
    await get("/sessions");
    await get(`${sessionPath()}/skills`);
    await get(`${sessionPath()}/warnings`);
    await get(`${sessionPath()}/interactions`);
    goto("subscribe");
    await connect();
    await command("subscribe", { session_id: "session_nonexistent" });
    await subscribe();
    await command("subscribe", { session_id: session, agent_ids: ["main"] });
    await command("subscribe", { session_id: session, agent_ids: ["nonexistent"] });
    goto("profile");
    await post(`${sessionPath()}/profile`, {
      agent_config: { model: "alternate", thinking: "off", permission_mode: "yolo" },
    });
    await get(sessionPath());
    await prompt("W409_PROFILE");
    await settled();
    await hist();
    await get(`${sessionPath()}/context/summary`);
    await post(`${sessionPath()}/profile`, { agent_config: { thinking: "impossible" } });
    await post(`${sessionPath()}/profile`, { agent_config: { model: "does-not-exist" } });
    await post(`${sessionPath()}/profile`, { agent_config: { model: "fixture", thinking: "on" } });
    goto("unsubscribe");
    await command("unsubscribe", { session_id: session });
    await get("/workspaces");
  },
  async conversation() {
    await fresh();
    goto("text");
    await prompt("W409_TEXT", { metadata: { client_tag: "fixture-tag" } });
    await settled();
    await hist();
    goto("tool");
    await prompt("W409_TOOL");
    await settled();
    goto("tool-failure");
    await prompt("W409_BADTOOL");
    await settled();
    goto("history-pages");
    const r = await hist("main", "?page_size=1");
    if (r.data.turns[0]) {
      await hist("main", `?page_size=1&before_ordinal=${r.data.turns[0].ordinal}`);
    }
    await hist("main", "?page_size=0");
    goto("fork");
    const fork = await post(`${sessionPath()}:fork`, { title: "Wire fork" });
    if (fork.data?.id) {
      await get(`/sessions/${fork.data.id}`);
      await get(`/sessions/${fork.data.id}/agents/main/turns`);
    }
    goto("history-reconnect");
    await closeWs();
    await connect();
    await subscribe();
    goto("restart-resume");
    await stop();
    await boot();
    await get(sessionPath());
    await hist();
    await connect();
    await subscribe();
    await prompt("W409_RESUMED");
    await settled();
    await hist();
  },
  async queue() {
    await fresh();
    goto("active");
    await prompt("W409_HOLD");
    await until(() => runningHold);
    await get(`${sessionPath()}/prompts`);
    await wait(0);
    goto("duplicate-active");
    await prompt("W409_HOLD");
    await prompt("W409_HOLD", { content: [{ type: "text", text: "changed body" }] });
    goto("enqueue");
    await prompt("W409_KEEP");
    await prompt("W409_WITHDRAW");
    await get(`${sessionPath()}/prompts`);
    goto("withdraw");
    await post(`${sessionPath()}/prompts/W409_WITHDRAW:abort`);
    await get(`${sessionPath()}/prompts`);
    await post(`${sessionPath()}/prompts/W409_WITHDRAW:abort`);
    goto("drain");
    runningHold.resolve();
    await settled();
    await hist();
    await get(`${sessionPath()}/prompts`);
    goto("late-abort");
    await post(`${sessionPath()}/prompts/W409_HOLD:abort`);
    await post(`${sessionPath()}:cancel`);
    await post(`${sessionPath()}/prompts/no-such-prompt:abort`);
    goto("replay-completed-id");
    await prompt("W409_KEEP");
    await settled();
    await hist();
    goto("active-abort");
    runningHold = undefined;
    await prompt("W409_HOLD2", { content: [{ type: "text", text: "W409_HOLD" }] });
    await until(() => runningHold);
    await post(`${sessionPath()}/prompts/W409_HOLD2:abort`);
    runningHold.resolve();
    await settled();
    await hist();
  },
  async interactions() {
    await fresh({ agent_config: { permission_mode: "manual" } });
    for (const kind of ["W409_ASK", "W409_APPROVE", "W409_DENY"]) {
      goto(kind);
      const begin = frames.length;
      await prompt(kind);
      const found = await until(
        () => frames.slice(begin).find((x) => x.b.type === "interaction" && x.b.status === "pending")?.b,
        6000,
      ).catch(() => {});
      await get(`${sessionPath()}/interactions`);
      await wait(0);
      if (found) {
        await closeWs();
        await connect();
        await subscribe();
        const route = `${sessionPath()}/interactions/${found.interaction_id}`;
        const body =
          found.kind === "question"
            ? {
                kind: "question",
                answers: {
                  [found.request.questions[0].id]: {
                    kind: "single",
                    option_id: found.request.questions[0].options[0].id,
                  },
                },
                method: "click",
              }
            : { kind: "approval", decision: kind === "W409_DENY" ? "rejected" : "approved" };
        await post(route, { kind: "question", answers: {}, dismissed: true });
        await post(route, body);
        await settled();
        await post(route, body);
        await get(`${sessionPath()}/interactions`);
      } else {
        record("boundary", { reason: "no pending interaction", marker: kind });
        await post(`${sessionPath()}:cancel`);
        await settled();
      }
    }
    await hist();
  },
  async tasks() {
    await fresh();
    goto("child");
    const i = frames.length;
    await prompt("W409_CHILD");
    const task = await until(() => frames.slice(i).find((x) => x.b.type === "task" && x.b.child_agent_id)?.b);
    await subscribe(task.child_agent_id);
    await until(() => runningHold);
    runningHold.resolve();
    await settled();
    await hist(task.child_agent_id);
    await hist();
    goto("background-shell");
    const j = frames.length;
    await prompt("W409_BG");
    const bg = await until(
      () =>
        frames.slice(j).find((x) => x.b.type === "task" && x.b.kind === "shell" && x.b.status === "running")
          ?.b,
    );
    const target = { session_id: session, agent_id: "main", task_id: bg.task_id };
    await command("task.watch", { ...target, tail_bytes: 2048 });
    await until(() => frames.slice(j).some((x) => x.b.type === "task.output" && x.b.text));
    await command("task.unwatch", target);
    await command("task.watch", { ...target, since_offset: 0 });
    await command("task.stop", target);
    await until(() =>
      frames
        .slice(j)
        .some((x) => x.b.type === "task" && x.b.task_id === bg.task_id && x.b.status === "ended"),
    );
    await command("task.stop", target);
    await command("task.stop", { ...target, task_id: "missing" });
    await settled();
  },
  async compact() {
    await fresh();
    goto("empty-compact");
    await post(`${sessionPath()}:compact`);
    await wait(5000);
    goto("populate");
    await prompt("W409_TEXT");
    await settled();
    await prompt("W409_TOOL");
    await settled();
    goto("compact");
    await post(`${sessionPath()}:compact`, { instruction: "Summarize this fixture." });
    await settled();
    await hist();
    await get(sessionPath());
    goto("after-compact");
    await prompt("W409_POST");
    await settled();
    await hist();
  },
  async failure() {
    await fresh();
    goto("invalid");
    await post(`${sessionPath()}/prompts`, { content: [] });
    await post("/sessions/session_nonexistent/prompts", { content: [{ type: "text", text: "test" }] });
    goto("model-error");
    await prompt("W409_FAILED");
    await settled();
    await hist();
    goto("recovery");
    await prompt("W409_RECOVER");
    await settled();
    await hist();
  },
  async media() {
    await fresh();
    goto("inline-image");
    const data =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    await prompt("W409_IMAGE", {
      content: [
        { type: "text", text: "W409_IMAGE" },
        { type: "image", name: "fixture.png", source: { kind: "base64", media_type: "image/png", data } },
      ],
    });
    await settled();
    await hist();
    goto("file");
    await prompt("W409_FILE", {
      content: [
        { type: "text", text: "W409_FILE" },
        { type: "file", path: path.join(cwd, "sample.txt") },
      ],
    });
    await settled();
    await hist();
  },
  async crash() {
    await fresh();
    goto("before-crash");
    await prompt("W409_TEXT");
    await settled();
    await prompt("W409_CRASH");
    await until(() => runningHold);
    await prompt("W409_QUEUED_BEFORE_EXIT");
    await get(`${sessionPath()}/prompts`);
    goto("kill-owned-cli");
    child.kill("SIGKILL");
    const [code, signal] = await bounded(exitWait);
    record("process.exit", { code, signal });
    child = undefined;
    await until(() => socket.readyState === 3);
    runningHold.resolve();
    goto("after-crash");
    await boot();
    await get(sessionPath());
    await get(`${sessionPath()}/prompts`);
    await hist();
    await connect();
    await subscribe();
    await prompt("W409_RECOVER");
    await settled();
    await hist();
  },
  async profiles() {
    goto("signed-in-readers");
    await get("/auth");
    await get("/models");
    await get("/sessions");
    await get("/tools");
    await fresh();
    goto("names-tools-skills");
    await post(`${sessionPath()}/profile`, { title: "Explicit fixture name" });
    await get(sessionPath());
    await get(`/tools?session_id=${session}`);
    const skills = await get(`${sessionPath()}/skills`);
    assert.ok(skills.data.skills.some((x) => x.name === "home409"));
    await post(`${sessionPath()}/skills/home409:activate`, { args: "W409_SKILL", prompt_id: "W409_SKILL" });
    await settled();
    await hist();
    await post(`${sessionPath()}/skills/no-such-skill:activate`, {});
    await get("/sessions");
    goto("denylist");
    await prompt("W409_DISABLE", { disabled_tools: ["Read"] });
    await settled();
    await get(`/tools?session_id=${session}`);
    await prompt("W409_PERSIST");
    await settled();
    await prompt("W409_RESET", { disabled_tools: [] });
    await settled();
    goto("tool-env-cwd");
    await prompt("W409_ENV");
    await settled();
    await hist();
    goto("goal");
    const profile = (agent_config) => post(`${sessionPath()}/profile`, { agent_config });
    await profile({ goal_control: "pause" });
    await profile({ goal_objective: "Inspect this fixture." });
    await profile({ goal_control: "pause" });
    await profile({ goal_control: "edit", goal_objective: "Updated fixture objective." });
    await profile({ goal_control: "resume" });
    await profile({ goal_control: "cancel" });
    await get(sessionPath());
    goto("plan");
    await profile({ plan_mode: true });
    await profile({ plan_mode: false });
  },
  async fork() {
    await fresh();
    goto("source-turns");
    for (const id of ["W409_ONE", "W409_TWO", "W409_THREE"]) {
      await prompt(id);
      await settled();
    }
    const source = session;
    for (const cut of [0, 1, 99]) {
      goto(`fork-${cut}`);
      const fork = await post(`/sessions/${source}:fork`, { turn_index: cut, title: `Cut ${cut}` });
      if (fork.data?.id) {
        session = fork.data.id;
        await hist();
        await prompt(`W409_FORK${cut}`);
        await settled();
        await hist();
      }
    }
    session = source;
    goto("source-after-forks");
    await hist();
    await stop();
    await boot();
    await hist();
  },
  async multi() {
    await fresh();
    const first = session;
    const other = await create();
    goto("other-session-unsubscribed");
    session = other;
    await prompt("W409_PEER");
    await settled();
    goto("subscribe-second");
    await subscribe();
    goto("parallel-turns");
    await Promise.all([
      post(`/sessions/${first}/prompts`, {
        prompt_id: "W409_A",
        content: [{ type: "text", text: "W409_A" }],
      }),
      prompt("W409_B"),
    ]);
    await Promise.all([post(`/sessions/${first}:wait`, { timeout_ms: 9000 }), wait()]);
    await pause(100);
    goto("detach-second");
    await command("unsubscribe", { session_id: other });
    await prompt("W409_UNSUBSCRIBED");
    await settled();
    goto("reconnect-during-turn");
    session = first;
    await prompt("W409_HOLD");
    await until(() => runningHold);
    await closeWs();
    await connect();
    await subscribe();
    runningHold.resolve();
    await settled();
    await hist();
  },
  async account() {
    goto("no-provider");
    await get("/meta");
    await get("/auth");
    await get("/oauth/login");
    await get("/oauth/usage");
    await get("/models");
    await get("/sessions");
    await get("/tools");
    await get("/sessions");
    const r = await post("/sessions", { cwd });
    if (r.data?.id) {
      session = r.data.id;
      await connect();
      await command("subscribe", { session_id: session });
      await prompt("W409_NO_PROVIDER");
      await wait(1000);
      await get(sessionPath());
    }
  },
  async claimed() {
    await fresh();
    goto("held-session");
    await prompt("W409_HOLD");
    await until(() => runningHold);
    await get(sessionPath());
    goto("second-cli-same-home");
    const firstChild = child,
      firstExit = exitWait,
      firstServer = web;
    try {
      await boot();
      await get(sessionPath());
      await get(`${sessionPath()}/prompts`);
      await post(`${sessionPath()}/profile`, { title: "Second CLI fixture" });
      await hist();
      await stop();
    } finally {
      web = firstServer;
      child = firstChild;
      exitWait = firstExit;
    }
    goto("owner-continues");
    runningHold.resolve();
    await settled();
    await hist();
  },
  async activecompact() {
    await fresh();
    goto("baseline");
    await prompt("W409_BASE");
    await settled();
    goto("running-compact");
    await prompt("W409_HOLD");
    await until(() => runningHold);
    await post(`${sessionPath()}:compact`);
    await wait(0);
    await post(`${sessionPath()}:cancel`);
    runningHold.resolve();
    await settled();
    await hist();
    goto("fresh-after-interrupt");
    await prompt("W409_NEXT");
    await settled();
    goto("manual-compact-boundary");
    const i = frames.length;
    await post(`${sessionPath()}:compact`);
    await until(() => frames.slice(i).find((x) => x.b.item?.kind === "compaction" || x.b.type === "notice"));
    await wait();
    await hist();
  },
  async effort() {
    await fresh({ agent_config: { model: "fixture", thinking: "high", permission_mode: "yolo" } });
    goto("create-high");
    await prompt("W409_HIGH");
    await settled();
    await stop();
    await boot();
    await connect();
    await subscribe();
    goto("resume-low");
    await post(`${sessionPath()}/profile`, { agent_config: { model: "fixture", thinking: "low" } });
    await prompt("W409_LOW");
    await settled();
  },
  async abortbyid() {
    await fresh();
    goto("running-bash-by-id");
    await prompt("W409_SHELL");
    await until(() => existsSync(path.join(cwd, "worker.pid")));
    await post(`${sessionPath()}/prompts/W409_SHELL:abort`);
    await settled();
    await hist();
    await prompt("W409_RECOVER");
    await settled();
  },
  async shutdownheld() {
    await fresh();
    goto("hold-websocket-open");
    await prompt("W409_SHELL");
    await until(() => existsSync(path.join(cwd, "worker.pid")));
    await post("/shutdown");
    const at = performance.now();
    await until(() => frames.some((x) => x.b.type === "turn.ended"), 9000);
    await pause(1000);
    record("shutdown-observation", {
      processExited: child.exitCode !== null,
      elapsedMs: Math.round(performance.now() - at),
      socketState: socket.readyState,
    });
    await closeWs();
    const [exitCode, signal] = await bounded(exitWait, 10_000);
    record("stopped", { exitCode, signal, shutdownMs: Math.round(performance.now() - at) });
    child = undefined;
    await boot();
    await get(sessionPath());
  },
  async toolstream() {
    await fresh();
    for (const marker of ["W409_TOOL", "W409_APPROVE", "W409_SHELL"]) {
      goto(marker);
      await prompt(marker);
      await settled();
      await hist("main", "?page_size=1");
    }
    record("filesystem", { writeExists: existsSync(path.join(cwd, "W409_APPROVE.txt")) });
  },
  async lifecycle() {
    await fresh();
    goto("persist");
    await prompt("W409_KEEP");
    await settled();
    await closeWs();
    goto("archive");
    await post(`${sessionPath()}:archive`);
    await get(sessionPath());
    await get("/sessions");
    await get("/sessions?archived=true");
    goto("restore");
    await post(`${sessionPath()}:restore`);
    await get(sessionPath());
    await hist();
    goto("delete-owned-fixture");
    await post(`${sessionPath()}:delete`);
    await get(sessionPath());
    await hist();
  },
  async startup() {
    goto("machine-banner");
    await get("/meta");
    session = await create();
    await stop();
    goto("other-kimi-home");
    const other = path.join(home, "other-kimi");
    await mkdir(other);
    await writeFile(path.join(other, "config.toml"), readFileSync(path.join(state, "config.toml")));
    env.KIMI_CODE_HOME = other;
    await boot();
    await get("/sessions");
    await get(sessionPath());
    await stop();
    goto("restore-kimi-home");
    env.KIMI_CODE_HOME = state;
    await boot();
    await get(sessionPath());
    goto("plain-banner");
    const plain = spawn(bin, ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"], {
      cwd,
      env: { ...env, KIMI_CODE_HOME: other },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const plainExit = once(plain, "exit");
    let banner = "";
    plain.stderr.resume();
    plain.stdout.on("data", (chunk) => {
      banner += chunk.toString();
    });
    try {
      await until(() => banner.includes("Ctrl+C"));
      record("plain-banner", {
        titlePresent: banner.includes("Kimi server ready"),
        versionPresent: banner.includes("2.7.2"),
        loopbackUrlPresent: /http:\/\/(?:127\.0\.0\.1|localhost):/u.test(banner),
        tokenLabelPresent: banner.includes("Token:"),
        stopHintPresent: banner.includes("Ctrl+C"),
        nonemptyLines: banner.split("\n").filter((l) => l.trim()).length,
      });
    } finally {
      plain.kill("SIGTERM");
      await bounded(plainExit);
    }
  },
  async env() {
    goto("env-default");
    await get("/auth");
    await get("/models");
    await fresh();
    await prompt("W409_ENV_DEFAULT");
    await settled();
    goto("env-override-profile");
    await post(`${sessionPath()}/profile`, { agent_config: { model: "alternate", thinking: "off" } });
    await prompt("W409_ENV_PROFILE");
    await settled();
    await get(sessionPath());
  },
  async model() {
    goto("unknown-model-create");
    await post("/sessions", { cwd, agent_config: { model: "missing409", thinking: "off" } });
    await get("/sessions");
    goto("unknown-effort-create");
    await post("/sessions", { cwd, agent_config: { model: "fixture", thinking: "missing409" } });
    await get("/sessions");
    goto("known-create");
    await fresh({ agent_config: { model: "alternate", thinking: "off", permission_mode: "yolo" } });
    await prompt("W409_SELECTED");
    await settled();
    await post(`${sessionPath()}/profile`, { agent_config: { model: "fixture", thinking: "on" } });
    await prompt("W409_CHANGED");
    await settled();
    await stop();
    goto("cold-resume-profile");
    await boot();
    await connect();
    await subscribe();
    await get(sessionPath());
    await post(`${sessionPath()}/profile`, { agent_config: { model: "alternate", thinking: "off" } });
    await prompt("W409_REAPPLY");
    await settled();
    await post(`${sessionPath()}/profile`, { agent_config: { thinking: "unknown-effort" } });
    await prompt("W409_UNKNOWN_EFFORT");
    await settled();
    await get(sessionPath());
  },
  async workdir() {
    goto("register");
    const reg = await post("/workspaces", {
      root: cwd,
      additional_dirs: [path.join(dir, "extra")],
      name: "Fixture registry",
      idempotency_key: "same409",
    });
    const wid = reg.data.id;
    const created = await post("/sessions", { workspace_id: wid, agent_config: { permission_mode: "yolo" } });
    session = created.data.id;
    await connect();
    await subscribe();
    await prompt("W409_ENV");
    await settled();
    await hist();
    await stop();
    goto("cold-same-cwd");
    await boot(cwd);
    await get(sessionPath());
    await connect();
    await subscribe();
    await prompt("SAME409", { content: [{ type: "text", text: "W409_SAME" }] });
    await settled();
    await stop();
    goto("cold-other-cwd");
    await boot(path.join(dir, "extra"));
    await get(sessionPath());
    await connect();
    await subscribe();
    await prompt("DIFF409", { content: [{ type: "text", text: "W409_ENVDIFF" }] });
    await settled();
    await hist();
    await get("/sessions/session_unknown409");
    await post("/sessions/session_unknown409:restore");
    goto("workspace-cleanup");
    await api("DELETE", `/workspaces/${wid}`);
    await get("/workspaces");
    await get(sessionPath());
    record("filesystem", { sourceFileStillExists: existsSync(path.join(cwd, "sample.txt")) });
  },
  async classes() {
    await fresh();
    for (const marker of ["W409_401", "W409_429", "W409_503", "W409_REJECTMODEL"]) {
      goto(marker);
      const i = frames.length;
      await prompt(marker);
      await until(() => frames.slice(i).some((x) => x.b.type === "turn.ended"), 45_000);
      await wait();
      await hist("main", "?page_size=1");
    }
    goto("recover-after-provider-failure");
    await prompt("W409_RECOVER");
    await settled();
  },
  async midtool() {
    await fresh();
    goto("abort-running-shell");
    await prompt("W409_SHELL");
    await until(() => existsSync(path.join(cwd, "worker.pid")));
    const pid = Number(readFileSync(path.join(cwd, "worker.pid"), "utf8"));
    const identity = stateOf(pid);
    record("worker", { pid, identity });
    await post(`${sessionPath()}:cancel`);
    await settled();
    record("worker", { pid, identity: stateOf(pid) });
    await hist();
    await prompt("W409_AFTER_ABORT");
    await settled();
    goto("shutdown-mid-tool");
    await rm(path.join(cwd, "worker.pid"), { force: true });
    await prompt("W409_SHELL2", { content: [{ type: "text", text: "W409_SHUT_SHELL" }] });
    await until(() => existsSync(path.join(cwd, "worker.pid")));
    const next = Number(readFileSync(path.join(cwd, "worker.pid"), "utf8"));
    record("worker", { pid: next, identity: stateOf(next) });
    await post("/shutdown?if_idle=true");
    const shutdownAt = performance.now();
    await post("/shutdown");
    await pause(300);
    record("shutdown-observation", {
      processExited: child.exitCode !== null,
      elapsedMs: Math.round(performance.now() - shutdownAt),
      workerPresent: Boolean(stateOf(next)),
      socketState: socket.readyState,
    });
    await closeWs();
    const [exitCode, signal] = await bounded(exitWait, 15_000);
    record("stopped", { exitCode, signal, shutdownMs: Math.round(performance.now() - shutdownAt) });
    child = undefined;
    record("worker", { pid: next, identity: stateOf(next) });
    await pause(150);
    record("worker", { pid: next, identity: stateOf(next) });
    goto("resume-after-shutdown");
    await boot();
    await get(sessionPath());
    await hist();
  },
  async backgroundchild() {
    await fresh();
    goto("background-subagent");
    const i = frames.length;
    await prompt("W409_CHILDBG");
    const t = await until(() => frames.slice(i).find((x) => x.b.type === "task" && x.b.child_agent_id)?.b);
    await subscribe(t.child_agent_id);
    await until(() => runningHold);
    await pause(120);
    runningHold.resolve();
    await until(() =>
      frames.slice(i).some((x) => x.b.type === "task" && x.b.task_id === t.task_id && x.b.status === "ended"),
    );
    await settled();
    await hist(t.child_agent_id);
    await hist();
  },
  async shrink() {
    await fresh();
    goto("populate");
    const pad = "red blue green yellow purple orange ".repeat(450);
    for (let j = 0; j < 4; j++) {
      const id = `W409_LONG${j}`;
      await prompt(id, { content: [{ type: "text", text: `${id} ${pad}` }] });
      await settled();
    }
    goto("compact-and-measure");
    const i = frames.length;
    await post(`${sessionPath()}:compact`, { instruction: "Summarize in two words." });
    await until(() => frames.slice(i).some((x) => x.b.item?.kind === "compaction"), 15_000);
    await until(() => frames.slice(i).some((x) => x.b.type === "agent" && x.b.compacting === false));
    await hist("main", "?page_size=1");
    goto("next-context");
    await prompt("W409_AFTER_SHRINK");
    await settled();
  },
  async imageonly() {
    await fresh();
    goto("image-only");
    const data =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    await prompt("W409_IMAGE_ONLY", {
      content: [{ type: "image", source: { kind: "base64", media_type: "image/png", data } }],
    });
    await settled();
    await hist();
    goto("path-image");
    const file = path.join(cwd, "pixel.png");
    await writeFile(file, Buffer.from(data, "base64"));
    await prompt("W409_IMAGE_PATH", {
      content: [
        { type: "text", text: "W409_IMAGE_PATH" },
        { type: "image", source: { kind: "path", path: file } },
      ],
    });
    await settled();
    await hist();
  },
  async "heartbeat-silent"() {
    await fresh();
    goto("silent");
    await until(() => socket.readyState === 3, 35_000);
  },
};
try {
  if (!Object.hasOwn(cases, scenario)) {
    throw new Error(`Unknown scenario: ${scenario}`);
  }
  if (scenario === "acpclasses") {
    await cases.acpclasses();
  } else {
    await boot();
    await cases[scenario]();
    goto("shutdown");
    await stop();
  }
  record("complete", { providerCalls });
} catch (error) {
  record("failure", { message: error.message, stack: error.stack });
  process.exitCode = 1;
} finally {
  await closeAll();
}
