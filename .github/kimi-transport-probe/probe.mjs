import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const [kind, prefix, outputArg, root] = process.argv.slice(2);
const output = path.resolve(outputArg);
const modules = path.resolve(prefix, "node_modules");

const startingCwd = process.cwd();
if (!root) throw new Error("The probe launcher must supply a temporary root");
const home = path.join(root, "home"),
  cwd = path.join(root, "project"),
  state = path.join(home, "kimi");
await Promise.all([mkdir(state, { recursive: true }), mkdir(cwd)]);
await writeFile(path.join(cwd, "example.txt"), "fixture read confirmed");
const results = {
  platform: process.platform,
  arch: process.arch,
  transport: kind,
  cli: JSON.parse(
    readFileSync(path.join(modules, "@moonshot-ai/kimi-code/package.json")),
  ).version,
  sdk: JSON.parse(
    readFileSync(path.join(modules, "@botiverse/kimi-code-sdk/package.json")),
  ).version,
  requests: [],
};
let held, release, listener, child, childExit, web, harness, socket;
const markers = [
  "FIRST333",
  "STEER333",
  "FOLLOW333",
  "ABORT333",
  "RESUME333",
  "PEER333",
  "CHILD333",
  "ASK333",
  "AFTERCOMPACT333",
];
const texts = (v) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));
const server = createServer(async (req, res) => {
  try {
    const parts = [];
    for await (const c of req) parts.push(c);
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
    const messages = body.messages ?? [];
    const tools = (body.tools ?? []).map((t) => t.function);
    const present = messages.flatMap((m) =>
      m.role === "user"
        ? markers.filter((k) => texts(m.content).includes(k))
        : [],
    );
    const last = present.at(-1);
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => texts(m.content))
      .join("");
    const row = {
      last,
      markers: present,
      model: body.model,
      role: system.includes("APPEND333"),
      profile: system.includes("PROFILE333"),
      replace: system.includes("REPLACE333"),
      standardPrompt: system.length > 200,
      tools: tools.map((t) => t.name),
      replies: messages
        .filter((m) => m.role === "tool")
        .map((m) => m.tool_call_id),
    };
    row.toolResults = messages
      .filter((m) => m.role === "tool")
      .map((m) => ({
        id: m.tool_call_id,
        readOK: texts(m.content).includes("fixture read confirmed"),
        gateOK: texts(m.content).includes("fixture gate ended"),
        snippet: texts(m.content).slice(0, 165),
      }));
    results.requests.push(row);
    if (held === last && release === undefined && held) {
      let resume;
      const gate = new Promise((resolve) => {
        resume = resolve;
      });
      release = resume;
      await gate;
    }
    const delta = (d, finish = null) =>
      "data: " +
      JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta: d, finish_reason: finish }],
      }) +
      "\n\n";
    const usage =
      "data: " +
      JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        model: "fixture",
        choices: [],
        usage: {
          prompt_tokens: 1234,
          completion_tokens: 10,
          total_tokens: 1244,
        },
      }) +
      "\n\n";
    let call;
    if (
      ["FIRST333", "STEER333"].includes(last) &&
      tools.some((t) => t.name === "Read") &&
      !row.replies.includes("call_" + last)
    ) {
      const t = tools.find((t) => t.name === "Read");
      const key = t.parameters.required?.[0] ?? "path";
      call = { name: t.name, args: { [key]: path.join(cwd, "example.txt") } };
    }
    if (listener) call = listener({ last, row, tools, messages, call });
    row.action = call?.name ?? "text";
    res.writeHead(200, { "content-type": "text/event-stream" });
    const answer = call
      ? delta({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_" + last,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            },
          ],
        }) + delta({}, "tool_calls")
      : delta({ role: "assistant", content: "Fixture completed." }) +
        delta({}, "stop");
    res.end(answer + usage + "data: [DONE]\n\n");
  } catch (e) {
    res.destroy();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + server.address().port + "/v1";
const keep = [
  "PATH",
  "Path",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "LANG",
];
const env = Object.fromEntries(
  keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
);
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: home,
  LOCALAPPDATA: home,
  TEMP: root,
  TMP: root,
  TMPDIR: root,
  XDG_CONFIG_HOME: state,
  XDG_DATA_HOME: state,
  XDG_CACHE_HOME: state,
  KIMI_CODE_HOME: state,
  KIMI_DISABLE_TELEMETRY: "1",
  KIMI_MODEL_NAME: "fixture",
  KIMI_MODEL_PROVIDER_TYPE: "openai",
  KIMI_MODEL_API_KEY: "fixture",
  KIMI_MODEL_BASE_URL: url,
  KIMI_MODEL_CAPABILITIES: "",
  KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: "0",
  NO_COLOR: "1",
});
await writeFile(
  path.join(state, "config.toml"),
  'default_model = "fixture"\nauto_session_title = false\n[providers.local]\ntype = "openai"\nbase_url = "' +
    url +
    '"\napi_key = "fixture"\n[models.fixture]\nprovider = "local"\nmodel = "fixture"\nmax_context_size = 65536\ncapabilities = []\n',
);
const until = async (fn, ms = 12000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await delay(25);
  }
  throw new Error("condition timeout");
};
const bounded = (p, ms = 12000) =>
  Promise.race([
    p,
    delay(ms, null, { ref: false }).then(() => {
      throw new Error("operation timed out");
    }),
  ]);
const newChild = (args) => {
  const bin = path.join(
    modules,
    ".bin",
    process.platform === "win32" ? "kimi.cmd" : "kimi",
  );
  // These fixed arguments and the temporary npm prefix are owned by the probe.
  const windows = process.platform === "win32";
  const executable = windows ? (env.ComSpec ?? env.COMSPEC ?? "cmd.exe") : bin;
  const launchArgs = windows
    ? ["/d", "/s", "/c", '""' + bin + '" ' + args.join(" ") + '"']
    : args;
  results.launcher = windows ? "npm kimi.cmd" : "npm kimi";
  child = spawn(executable, launchArgs, {
    windowsVerbatimArguments: windows,
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  childExit = once(child, "exit");
  return createInterface({ input: child.stdout });
};
async function boot() {
  const start = Date.now();
  const lines = newChild([
    "web",
    "--json",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
  ]);
  const [line] = await bounded(once(lines, "line"));
  web = JSON.parse(line);
  assert.equal(new URL(web.origin).hostname, "127.0.0.1");
  results.readyMs = Date.now() - start;
  results.protocol = web.kimi_agent_protocol_version;
  lines.close();
}
async function api(method, route, body) {
  const r = await fetch(web.origin + "/api/v1" + route, {
    method,
    redirect: "error",
    headers: {
      Authorization: "Bearer " + web.token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const payload = await r.json();
  if (!r.ok || payload.code !== 0)
    throw new Error(
      method +
        " " +
        route +
        " " +
        r.status +
        " " +
        texts(payload.message ?? payload.error?.message ?? payload.code).slice(
          0,
          160,
        ),
    );
  return payload.data;
}
const post = (r, b = {}) => api("POST", r, b),
  get = (r) => api("GET", r);
const content = (t) => ({ content: [{ type: "text", text: t }], prompt_id: t });
async function stop() {
  const original = web.origin;
  const now = Date.now();
  results.shutdown = await post("/shutdown");
  await bounded(childExit, 8000);
  child = undefined;
  results.shutdownMs = Date.now() - now;
  try {
    await fetch(original + "/api/v1/meta", {
      signal: AbortSignal.timeout(400),
    });
    results.portClosed = false;
  } catch {
    results.portClosed = true;
  }
}
async function check(label, fn) {
  try {
    results[label] = await fn();
  } catch (e) {
    results[label] = { error: String(e.message).slice(0, 230) };
  }
}
const onceTool = (name, args, marker, row, tools) =>
  tools.some((t) => t.name === name) && !row.replies.includes("call_" + marker)
    ? { name, args }
    : undefined;
listener = ({ last, row, tools, call, messages }) => {
  if (last === "FIRST333") {
    const tool = tools.find((t) => ["Bash", "Shell"].includes(t.name));
    if (!tool || row.replies.includes("call_FIRST333")) return;
    return { name: tool.name, args: { command: "node gate.cjs" } };
  }
  if (
    last === "CHILD333" &&
    !texts(messages.at(-1)?.content).includes("SUBFIX333")
  )
    return onceTool(
      "Agent",
      {
        description: "Read fixture",
        prompt: "Return SUBFIX333 without tools.",
      },
      last,
      row,
      tools,
    );
  if (last === "ASK333")
    return onceTool(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "Select a test color",
            header: "Color",
            options: [
              { label: "Red", description: "red" },
              { label: "Blue", description: "blue" },
            ],
            multi_select: false,
          },
        ],
      },
      last,
      row,
      tools,
    );
  return call;
};
const gateReady = path.join(cwd, "started"),
  gateDone = path.join(cwd, "released");
await writeFile(
  path.join(cwd, "gate.cjs"),
  'const fs=require("node:fs");fs.writeFileSync("started","yes");let n=0;const t=setInterval(()=>{if(fs.existsSync("released")||++n>150){clearInterval(t);console.log("fixture gate ended")}},100);',
);
const profileFile = path.join(state, "agents", "comparison-profile.md");
await mkdir(path.dirname(profileFile), { recursive: true });
await writeFile(
  profileFile,
  "---\nname: comparison-profile\ndescription: A test profile.\n---\n\nPROFILE333.\n",
);
const openGate = () => writeFile(gateDone, "yes");

const publicConfigMarker = "transport-test-option-333";
const echoArgs = [
  fileURLToPath(new URL("./echo.mjs", import.meta.url)),
  publicConfigMarker,
];
async function diskMarkerFiles() {
  const found = [];
  async function visit(dir) {
    const entries = await sample(() => readdir(dir, { withFileTypes: true }));
    for (const entry of entries ?? []) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const data = await sample(() => readFile(file));
        if (data?.includes(publicConfigMarker))
          found.push(path.relative(state, file).split(path.sep).join("/"));
      }
    }
  }
  async function sample(read) {
    try {
      return await read();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      results.vanishedDuringScan = (results.vanishedDuringScan ?? 0) + 1;
    }
  }
  await visit(state);
  return found;
}
function selectTurns(r) {
  return r.turns.map((t) => ({
    id: t.turn_id,
    outcome: t.outcome,
    usage: t.usage,
    items: t.items.map((i) => ({
      type: i.type,
      markers: markers.filter((k) => texts(i).includes(k)),
      tool: i.name ?? i.tool_name,
      agent: i.agent_id ?? i.child_agent_id,
    })),
  }));
}
function attachEvents(session, events) {
  session.onEvent((e) =>
    events.push({
      type: e.type,
      agent: e.agentId ?? e.agent_id,
      turn: e.turnId ?? e.turn_id,
      keys: Object.keys(e),
      ...(e.type === "turn.ended" ? { reason: e.reason } : {}),
      ...(e.type.includes("subagent")
        ? {
            attribution: Object.fromEntries(
              Object.entries(e).filter(
                ([k, v]) => /id$/i.test(k) && typeof v === "string",
              ),
            ),
          }
        : {}),
    }),
  );
}
async function sdk() {
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const sentinel = path.join(root, "selected-cli-used");
  env.KIMI_PROBE_SENTINEL = sentinel;
  await writeFile(
    path.join(bin, "kimi"),
    '#!/bin/sh\necho used > "$KIMI_PROBE_SENTINEL"\nexit 91\n',
    { mode: 0o755 },
  );
  await writeFile(
    path.join(bin, "kimi.cmd"),
    '@echo used > "%KIMI_PROBE_SENTINEL%"\r\n@exit /b 91\r\n',
  );
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path");
  env[pathKey] = bin + path.delimiter + env[pathKey];
  for (const k of Object.keys(process.env))
    if (!Object.hasOwn(env, k)) delete process.env[k];
  Object.assign(process.env, env);
  process.chdir(cwd);
  const { createKimiHarness } = await import(
    pathToFileURL(path.join(modules, "@botiverse/kimi-code-sdk/dist/index.mjs"))
  );
  const newHarness = () =>
    createKimiHarness({
      homeDir: state,
      identity: {
        productName: "kimi-code-cli",
        version: "2.3.1",
        platform: "kimi_code_cli",
      },
      roleAdditional: "APPEND333",
      baseEnv: env,
    });
  harness = newHarness();
  let s = await harness.createSession({ workDir: cwd });
  const id = s.id;
  const events = (results.events = []);
  attachEvents(s, events);
  s.setApprovalHandler(() => {
    results.approvalSeen = true;
    return { decision: "approved", scope: "once" };
  });
  s.setQuestionHandler(() => {
    results.questionSeen = true;
    return null;
  });
  await check("mcp", async () => {
    const b = await harness.createSession({ workDir: cwd });
    await s.addMcpServer({
      name: "scope333",
      transport: "stdio",
      command: process.execPath,
      args: echoArgs,
    });
    await s.reloadSession();
    results.configOnDiskAtAttach = await diskMarkerFiles();
    await b.prompt("PEER333");
    await until(() => results.requests.some((r) => r.last === "PEER333"));
    await b.close();
    return {
      file: existsSync(path.join(state, "mcp.json")),
      names: (await s.listMcpServers()).map((v) => v.name),
    };
  });
  await s.setPermission("yolo");
  const turn = async (t) => {
    let ended = false;
    const off = s.onEvent((e) => {
      if (e.type === "turn.ended") ended = true;
    });
    try {
      await s.prompt(t);
      await until(() => ended, 20000);
    } finally {
      off();
    }
  };
  await s.prompt("FIRST333");
  await until(() => existsSync(gateReady));
  results.originalToolEntered = true;
  const steering = s.steer("STEER333");
  await delay(120);
  await openGate();
  await bounded(steering);
  await until(
    () => results.requests.some((r) => r.replies.includes("call_STEER333")),
    16000,
  );
  await delay(450);
  await turn("FOLLOW333");
  await check("context", async () => {
    const r = await s.getContext();
    return Object.fromEntries(
      Object.entries(r).filter(
        ([k, v]) => typeof v === "number" || k === "model",
      ),
    );
  });
  await check("usage", () => s.getUsage());
  await check("modelEffort", async () => {
    await s.setModel("fixture");
    await s.setThinking("off");
    return true;
  });
  await check("compact", async () => {
    await s.compact();
    return true;
  });
  await turn("AFTERCOMPACT333");
  await check("subagent", async () => {
    await turn("CHILD333");
    return true;
  });
  await s.setPermission("manual");
  s.setQuestionHandler(() => {
    results.questionSeen = true;
    return null;
  });
  await check("interaction", async () => {
    await turn("ASK333");
    return true;
  });
  held = "ABORT333";
  release = undefined;
  await s.prompt(held);
  await until(() => !!release);
  const cancel = s.cancel();
  held = undefined;
  release();
  await bounded(cancel);
  results.abort = true;
  await s.close();
  await harness.close();
  harness = newHarness();
  s = await harness.resumeSession({ id, workDir: cwd });
  attachEvents(s, events);
  await turn("RESUME333");
  results.resumeSameId = s.id === id;
  await s.close();
}
async function acp() {
  let seq = 0;
  const updates = (results.events = []);
  function channel() {
    const pending = new Map();
    const lines = newChild(["acp"]);
    const send = (row) =>
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...row }) + "\n");
    lines.on("line", (l) => {
      let m;
      try {
        m = JSON.parse(l);
      } catch {
        return;
      }
      if (m.method && m.id !== undefined) {
        (results.clientMethods ??= []).push(m.method);
        const allow = m.params?.options?.find((x) => x.kind === "allow_once");
        send(
          allow
            ? {
                id: m.id,
                result: {
                  outcome: { outcome: "selected", optionId: allow.optionId },
                },
              }
            : { id: m.id, error: { code: -32601, message: "not supported" } },
        );
        return;
      }
      if (m.method) {
        const u = m.params?.update ?? {};
        updates.push({
          type: u.sessionUpdate,
          usage:
            u.sessionUpdate === "usage_update"
              ? { used: u.used, size: u.size }
              : undefined,
          meta: u._meta,
          tool: u.title,
        });
        return;
      }
      const waiter = pending.get(m.id);
      if (waiter) {
        pending.delete(m.id);
        if (m.error) waiter.reject(Error(m.error.code + " " + m.error.message));
        else waiter.resolve(m.result);
      }
    });
    return {
      ask: (method, params) => {
        const id = ++seq;
        const req = Promise.withResolvers();
        pending.set(id, req);
        send({ id, method, params });
        return bounded(req.promise, 25000);
      },
      notify: (method, params) => send({ method, params }),
    };
  }
  let c = channel();
  const init = () =>
    c.ask("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "transport-probe", version: "1" },
    });
  results.initialize = await init();
  const server = {
    name: "scope333",
    command: process.execPath,
    args: echoArgs,
    env: [],
  };
  const opened = await c.ask("session/new", {
    cwd,
    mcpServers: [server],
    systemPrompt: "REPLACE333",
    appendSystemPrompt: "APPEND333",
  });
  const id = opened.sessionId;
  results.options = opened.configOptions?.map((o) => ({
    id: o.id,
    value: o.currentValue,
    options: o.options?.map((v) => v.value),
  }));
  const b = await c.ask("session/new", { cwd, mcpServers: [] });
  const prompt = (s, t) =>
    c.ask("session/prompt", {
      sessionId: s,
      prompt: [{ type: "text", text: t }],
    });
  await prompt(b.sessionId, "PEER333");
  await c.ask("session/set_mode", { sessionId: id, modeId: "yolo" });
  results.configOnDiskAtAttach = await diskMarkerFiles();
  await check("effort", () =>
    c.ask("session/set_config_option", {
      sessionId: id,
      configId: "thinking",
      value: "off",
    }),
  );
  const option = opened.configOptions?.find((o) => o.id === "model");
  if (option)
    await check("modelChoice", () =>
      c.ask("session/set_config_option", {
        sessionId: id,
        configId: option.id,
        value: option.currentValue,
      }),
    );
  const first = prompt(id, "FIRST333");
  await until(() => existsSync(gateReady));
  results.originalToolEntered = true;
  await check("steer", () =>
    c.ask("session/steer", {
      sessionId: id,
      prompt: [{ type: "text", text: "STEER333" }],
    }),
  );
  await check("steeringExtension", () =>
    c.ask("_session/steering", {
      sessionId: id,
      prompt: [{ type: "text", text: "STEER333" }],
    }),
  );
  const simultaneous = prompt(id, "STEER333").then(
    (v) => ({ ok: v }),
    (e) => ({ error: e.message }),
  );
  await delay(120);
  await openGate();
  results.first = await first;
  results.concurrent = await simultaneous;
  await prompt(id, "FOLLOW333");
  await check("compact", () => c.ask("session/compact", { sessionId: id }));
  await check("compactCommand", () => prompt(id, "/compact"));
  await prompt(id, "AFTERCOMPACT333");
  await check("subagent", () => prompt(id, "CHILD333"));
  await check("interaction", () => prompt(id, "ASK333"));
  held = "ABORT333";
  release = undefined;
  const running = prompt(id, held);
  await until(() => !!release);
  c.notify("session/cancel", { sessionId: id });
  await delay(150);
  held = undefined;
  release();
  results.abort = await running;
  child.stdin.end();
  await bounded(childExit);
  child = undefined;
  c = channel();
  await init();
  await c.ask("session/resume", { sessionId: id, cwd, mcpServers: [server] });
  await prompt(id, "RESUME333");
  results.resumeSameId = true;
  results.mcpFile = existsSync(path.join(state, "mcp.json"));
  child.stdin.end();
  await bounded(childExit);
  child = undefined;
}

async function kap() {
  await boot();
  let id;
  const create = await post("/sessions", {
    cwd,
    agent_config: { permission_mode: "yolo" },
    systemPrompt: "REPLACE333",
    appendSystemPrompt: "APPEND333",
    mcpServers: {
      perSession333: {
        transport: "stdio",
        command: process.execPath,
        args: echoArgs,
      },
    },
  });
  id = create.id;
  await check("namedProfile", async () => {
    const x = await post("/sessions", {
      cwd,
      agent_config: { profile: "comparison-profile" },
    });
    await post("/sessions/" + x.id + "/prompts", content("PEER333"));
    await post("/sessions/" + x.id + ":wait", { timeout_ms: 10000 });
    return results.requests.some((r) => r.last === "PEER333" && r.profile);
  });
  results.configOnDiskAtAttach = await diskMarkerFiles();
  results.wire = [];
  socket = new WebSocket(web.ws_url, ["kimi-code.bearer." + web.token]);
  await bounded(
    new Promise((ok, no) => {
      socket.onopen = ok;
      socket.onerror = () => no(Error("WebSocket open failed"));
    }),
  );
  socket.onmessage = (e) => {
    const f = JSON.parse(e.data);
    const selected = Object.fromEntries(
      Object.entries(f).filter(([k]) =>
        [
          "type",
          "agent_id",
          "turn_id",
          "context_tokens",
          "max_context_tokens",
          "thinking",
          "model",
          "status",
          "outcome",
          "permission_mode",
          "parent_agent_id",
          "child_agent_id",
          "kind",
          "task_id",
        ].includes(k),
      ),
    );
    if (f.type === "task" && f.child_agent_id) {
      socket.send(
        JSON.stringify({
          type: "subscribe",
          request_id: "child-" + f.child_agent_id,
          session_id: id,
          agent_ids: [f.child_agent_id],
        }),
      );
    }
    if (f.type === "task")
      selected.task = f.task
        ? Object.fromEntries(
            Object.entries(f.task).filter(([k]) =>
              ["id", "agent_id", "kind", "status", "subagent_id"].includes(k),
            ),
          )
        : undefined;
    if (f.type === "item" && f.item) selected.itemType = f.item.type;
    results.wire.push(selected);
  };
  socket.send(
    JSON.stringify({ type: "subscribe", request_id: "probe", session_id: id }),
  );
  const session = "/sessions/" + id;
  const peer = await post("/sessions", { cwd });
  const wait = async (s = session) => {
    const reply = await post(s + ":wait", { timeout_ms: 10000 });
    if (reply.timed_out) throw new Error("wait timed out");
    return reply.session.last_turn_outcome;
  };
  const prompt = async (t) => post(session + "/prompts", content(t));
  await prompt("FIRST333");
  await until(() => existsSync(gateReady));
  results.originalToolEntered = true;
  const steering = post(session + "/steer", content("STEER333"));
  await delay(150);
  await openGate();
  results.steer = (await steering).status;
  await wait();
  await prompt("FOLLOW333");
  await wait();
  await check("turns", async () =>
    selectTurns(await get(session + "/agents/main/turns")),
  );
  await check("context", () => get(session + "/context/summary"));
  await check("profile", () => get(session));
  await check("modelEffort", () =>
    api("POST", session + "/profile", {
      agent_config: { model: "fixture", thinking: "off" },
    }),
  );
  await check("compact", async () => {
    const r = await post(session + ":compact");
    await wait();
    return r;
  });
  await prompt("AFTERCOMPACT333");
  await wait();
  await check("subagent", async () => {
    await prompt("CHILD333");
    const r = await wait();
    return {
      result: r,
      turns: selectTurns(await get(session + "/agents/main/turns")),
    };
  });
  await check("interaction", async () => {
    await prompt("ASK333");
    await wait();
    const { items } = await get(session + "/interactions");
    if (!items.length) return { pending: 0 };
    const i = items[0];
    const reply = await post(
      session + "/interactions/" + (i.interaction_id ?? i.id),
      { kind: "question", dismissed: true },
    );
    await wait();
    return { kind: i.kind, reply };
  });
  held = "ABORT333";
  release = undefined;
  const active = await prompt(held);
  await until(() => release !== undefined);
  await check("abort", () =>
    post(session + "/prompts/" + active.prompt_id + ":abort"),
  );
  held = undefined;
  release();
  await wait();
  await check("mcp", async () => {
    const file = path.join(state, "mcp.json");
    const before = existsSync(file);
    const add = await post("/mcp/servers", {
      name: "scope333",
      transport: "http",
      url: "http://127.0.0.1:1/unused",
      enabled: false,
    });
    const peerList = await get(
      "/mcp/servers?cwd=" + encodeURIComponent(peer.cwd ?? cwd),
    );
    return {
      before,
      fileContainsPublicName:
        existsSync(file) && readFileSync(file, "utf8").includes("scope333"),
      catalog: peerList.map((s) => s.name),
      inlineInCatalog: add.some((s) => s.name === "perSession333"),
    };
  });
  socket.close();
  await stop();
  await boot();
  await prompt("RESUME333");
  await wait();
  results.resumeSameId = (await get(session)).id === id;
  await stop();
}
try {
  if (kind === "kap") await kap();
  else if (kind === "sdk") await sdk();
  else if (kind === "acp") await acp();
  else throw new Error("unknown transport");
} catch (e) {
  results.error = e.message;
  process.exitCode = 1;
} finally {
  release?.();
  results.configOnDiskAtEnd = await diskMarkerFiles();
  if (kind === "sdk")
    results.selectedCliInvoked = existsSync(
      path.join(root, "selected-cli-used"),
    );
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await bounded(childExit, 5000).catch(() => {});
  }
  await harness?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await writeFile(output, JSON.stringify(results, null, 2));
  process.chdir(startingCwd);
  console.log(kind, results.error ?? "completed", results.requests.length);
}
