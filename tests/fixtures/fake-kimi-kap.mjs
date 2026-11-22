/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function, eslint/complexity, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/no-unsafe-argument, typescript/strict-boolean-expressions -- Standalone untyped fixture executable. */
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { attachKapWsServer } from "./fake-kimi-kap-ws.mjs";

const args = process.argv.slice(2);
const scenario = process.env.FAKE_KIMI_SCENARIO ?? "normal";
const logFile = process.env.FAKE_KIMI_LOG;
const bearer = process.env.FAKE_KIMI_TOKEN ?? "secret-kap-bearer-token-123";

function recordLog(entry) {
  if (logFile) { appendFileSync(logFile, `${JSON.stringify(entry)}\n`); }
}

function runAcpStub() {
  recordLog({ mode: "acp", args });
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const req = JSON.parse(line);
    if (req.method === "initialize") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: {} } })}\n`);
    } else if (req.method === "session/new") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { sessionId: "acp-fallback-session-1" } })}\n`);
    } else if (req.method === "session/prompt") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } })}\n`);
    }
  });
}

function sendOk(res, data) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: 0, msg: "ok", data }));
}

function sendErr(res, code, msg) {
  let status = 200;
  if (code === 40_100) { status = 401; } else if (code === 40_400) { status = 404; }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ code, msg, data: null }));
}

function emitPromptTurn(wsHub, promptId, texts) {
  const now = new Date().toISOString();
  wsHub.broadcast({ type: "turn.started", session_id: "kap-sess-1", agent_id: "main", event_created_at: now, turn: { turn_id: `turn-${promptId}`, ordinal: 0, kind: "agent", status: "running", steps: [] } });
  wsHub.broadcast({ type: "item.ended", session_id: "kap-sess-1", agent_id: "main", turn_id: `turn-${promptId}`, event_created_at: now, item: { type: "user_message", item_id: `um-${promptId}`, status: "ended", created_at: now, prompt_ids: [promptId], placement: "opener", origin: { kind: "user" }, text: texts, attachments: [], skills: [] } });
}

function emitTurnCompletion(wsHub, promptId, texts) {
  if (texts.includes("INTERACT")) {
    wsHub.broadcast({ type: "interaction", session_id: "kap-sess-1", agent_id: "main", interaction_id: "int-approval-1", kind: "approval", status: "pending", tool_call_id: "call-1" });
    return;
  }
  const now = new Date().toISOString();
  wsHub.broadcast({ type: "item.ended", session_id: "kap-sess-1", agent_id: "main", turn_id: `turn-${promptId}`, event_created_at: now, item: { type: "assistant_message", item_id: `am-${promptId}`, status: "ended", created_at: now, text: `reply:${texts}` } });
  wsHub.broadcast({ type: "turn.ended", session_id: "kap-sess-1", agent_id: "main", event_created_at: now, turn: { turn_id: `turn-${promptId}`, ordinal: 0, kind: "agent", status: "ended", outcome: "completed", steps: [], usage: { input_other: 5, output: 2, input_cache_read: 0, input_cache_creation: 0 } } });
}

function handleGetSession(url, res) {
  const sid = decodeURIComponent(url.slice("/api/v1/sessions/".length));
  if (scenario === "resume_not_found") { sendErr(res, 40_401, "Session not found"); return; }
  if (scenario === "resume_archived") { sendOk(res, { id: sid, cwd: process.cwd(), archived: true }); return; }
  if (scenario === "resume_other_cwd") { sendOk(res, { id: sid, cwd: "/some/other/dir" }); return; }
  sendOk(res, { id: sid, cwd: process.cwd() });
}

function handleResumeSession(ctx, res) {
  const sid = decodeURIComponent(ctx.url.slice("/api/v1/sessions/".length, -":resume".length));
  if (scenario === "resume_in_use") { sendErr(res, 40_931, "Session is in use"); return; }
  if (scenario === "effort_rejected") { sendErr(res, 40_001, "Unsupported thinking level"); return; }
  ctx.sessions.set(sid, { id: sid, cwd: process.cwd(), model: ctx.body.agent_config?.model ?? "default-model", thinking: ctx.body.agent_config?.thinking ?? "off" });
  sendOk(res, { id: sid, cwd: process.cwd() });
}

function handlePostSession(ctx, res) {
  const id = "kap-sess-1";
  ctx.sessions.set(id, { id, cwd: process.cwd(), model: ctx.body.agent_config?.model ?? "default-model", thinking: ctx.body.agent_config?.thinking ?? "off" });
  sendOk(res, { id, cwd: process.cwd() });
}

function handleCompact(wsHub, res) {
  sendOk(res, { compacting: true });
  setTimeout(() => {
    const now = new Date().toISOString();
    wsHub.broadcast({ type: "turn.started", session_id: "kap-sess-1", agent_id: "main", event_created_at: now, turn: { turn_id: "sys-compact-1", ordinal: 1, kind: "system", status: "ended", outcome: "completed", steps: [] } });
    wsHub.broadcast({ type: "item.ended", session_id: "kap-sess-1", agent_id: "main", turn_id: "sys-compact-1", event_created_at: now, item: { type: "system", kind: "compaction", item_id: "cmp-1", status: "ended", outcome: "completed", trigger: "manual", created_at: now } });
  }, 20);
}

function handleInteraction(ctx, res) {
  sendOk(res, { resolved: true });
  setTimeout(() => {
    const now = new Date().toISOString();
    ctx.wsHub.broadcast({ type: "item.ended", session_id: "kap-sess-1", agent_id: "main", turn_id: `turn-${ctx.state.latestPromptId}`, event_created_at: now, item: { type: "assistant_message", item_id: `am-after-int-${ctx.state.latestPromptId}`, status: "ended", created_at: now, text: "after-interaction" } });
    ctx.wsHub.broadcast({ type: "turn.ended", session_id: "kap-sess-1", agent_id: "main", event_created_at: now, turn: { turn_id: `turn-${ctx.state.latestPromptId}`, ordinal: 0, kind: "agent", status: "ended", outcome: "completed", steps: [] } });
  }, 15);
}

function handlePrompt(ctx, res) {
  const { prompt_id: promptId, content = [] } = ctx.body;
  ctx.state.latestPromptId = promptId;
  const texts = content.filter((p) => p.type === "text").map((p) => p.text).join("");
  const emitBeforeHttp = texts.includes("RACE_WS_FIRST");
  if (emitBeforeHttp) { emitPromptTurn(ctx.wsHub, promptId, texts); } else { setTimeout(() => { emitPromptTurn(ctx.wsHub, promptId, texts); }, 10); }
  if (texts.includes("HOLD_FOR_CONTROLS")) {
    ctx.state.heldPromptRelease = () => { ctx.state.heldPromptRelease = null; emitTurnCompletion(ctx.wsHub, promptId, texts); };
  } else if (!texts.includes("HANG_ABORT")) {
    setTimeout(() => { emitTurnCompletion(ctx.wsHub, promptId, texts); }, 30);
  }
  if (emitBeforeHttp) { setTimeout(() => { sendOk(res, { prompt_id: promptId }); }, 40); } else { sendOk(res, { prompt_id: promptId }); }
}

function dispatchRoute(ctx, res) {
  if (ctx.method === "GET" && ctx.url === "/api/v1/meta") {
    const capabilities = scenario === "missing_cap"
      ? { websocket: true, tasks: true, session_ephemeral_mcp: true }
      : { websocket: true, tasks: true, session_ephemeral_mcp: true, session_append_system_prompt: true, steer_parent_correlation: true };
    sendOk(res, { server_version: "2.7.2-botiverse.1", capabilities });
    return;
  }
  if (ctx.method === "GET" && ctx.url === "/api/v1/auth") {
    sendOk(res, scenario === "auth_missing" ? { models_ready: false, message: `No credentials configured for ${bearer}` } : { models_ready: true });
    return;
  }
  if (ctx.method === "POST" && ctx.url === "/api/v1/workspaces") {
    sendOk(res, { id: "ws-1", root: ctx.body.root, additional_dirs: ctx.body.additional_dirs ?? [] });
    return;
  }
  if (ctx.method === "POST" && ctx.url === "/api/v1/sessions") { handlePostSession(ctx, res); return; }
  if (ctx.method === "GET" && ctx.url.startsWith("/api/v1/sessions/")) { handleGetSession(ctx.url, res); return; }
  if (ctx.method === "POST" && ctx.url.endsWith(":resume")) { handleResumeSession(ctx, res); return; }
  if (ctx.method === "POST" && ctx.url.endsWith("/prompts")) { handlePrompt(ctx, res); return; }
  if (ctx.method === "POST" && ctx.url.includes("/interactions/")) { handleInteraction(ctx, res); return; }
  dispatchSecondaryRoute(ctx, res);
}

function dispatchSecondaryRoute(ctx, res) {
  if (ctx.method === "POST" && ctx.url.endsWith("/steer")) {
    sendOk(res, { prompt_id: ctx.body.prompt_id });
    if (ctx.state.heldPromptRelease) {
      const release = ctx.state.heldPromptRelease;
      setTimeout(() => { release(); }, 20);
    }
    return;
  }
  if (ctx.method === "POST" && ctx.url.endsWith(":compact")) { handleCompact(ctx.wsHub, res); return; }
  if (ctx.method === "POST" && ctx.url.endsWith(":cancel")) {
    sendOk(res, { cancelled: true });
    if (scenario !== "abort_hang") {
      setTimeout(() => {
        ctx.state.heldPromptRelease = null;
        ctx.wsHub.broadcast({ type: "turn.ended", session_id: "kap-sess-1", agent_id: "main", event_created_at: new Date().toISOString(), turn: { turn_id: `turn-${ctx.state.latestPromptId}`, ordinal: 0, kind: "agent", status: "ended", outcome: "interrupted", end_reason: "user_cancelled", steps: [] } });
      }, 15);
    }
    return;
  }
  if (ctx.method === "POST" && ctx.url === "/api/v1/shutdown") {
    recordLog({ shutdownWsOpen: ctx.wsHub.size() > 0 });
    sendOk(res, { shutting_down: true });
    setTimeout(() => { ctx.server.close(() => { process.exit(0); }); }, 10);
    return;
  }
  sendErr(res, 40_400, `Unhandled route ${ctx.url}`);
}

function runKapStub() {
  if (scenario === "unknown_json_flag") {
    process.stderr.write("error: unknown option '--json'\n");
    process.exit(2);
  }
  const sessions = new Map();
  const state = { heldPromptRelease: null, latestPromptId: null };
  let wsHub = null;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${bearer}`) { sendErr(res, 40_100, "Unauthorized"); return; }
    const chunks = [];
    req.on("data", (c) => { chunks.push(c); });
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const body = rawBody ? JSON.parse(rawBody) : {};
      const url = req.url ?? "";
      recordLog({ method: req.method, url, body });
      dispatchRoute({ method: req.method ?? "GET", url, body, sessions, state, wsHub, server }, res);
    });
  });
  wsHub = attachKapWsServer(server, { bearer, scenario, sessions, recordLog });
  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    process.stdout.write(`${JSON.stringify({ origin: `http://127.0.0.1:${addr.port}`, ws_url: `ws://127.0.0.1:${addr.port}/api/v1/ws`, token: bearer, kimi_agent_protocol_version: "1.0.0" })}\n`);
  });
}

if (args[0] === "acp") { runAcpStub(); } else { runKapStub(); }
