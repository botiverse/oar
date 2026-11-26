/* oxlint-disable import/no-nodejs-modules, eslint/max-lines, eslint/no-underscore-dangle, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-return, unicorn/prefer-top-level-await -- Standalone ACP wire fixture replaying Hermes gateway 0.23.3 shapes. */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { attachEditorServers, callEditorTool, closeEditorServers, editorMcpFingerprint } from "./fake-hermes-editor-mcp.mjs";

/*
 * `hermes-acp` is a viewer of the Hermes gateway daemon. These are the frames
 * recorded from `hermes-acp 0.23.3+1139.g084538c`: protocol 1, image prompts,
 * load/list/resume/fork, the `Edits` + `Reasoning effort` config selectors, a
 * post-reply `available_commands_update`, and `models` only when a provider is
 * configured. The fixture answers the same shapes without a gateway.
 */

const logPath = process.env.FAKE_HERMES_CALL_LOG;
const sessionId = process.env.FAKE_HERMES_SESSION_ID ?? "local-fake-hermes";
const models = process.env.FAKE_HERMES_MODELS === undefined
  ? undefined
  : JSON.parse(process.env.FAKE_HERMES_MODELS);
let currentModel = models?.currentModelId ?? "fake:model-a";
let currentEffort = process.env.FAKE_HERMES_EFFORT ?? "default";
let currentMode = "default";
const pendingPrompts = new Map();
const pending = new Map();
// The session's editor MCP servers, borrowed in THIS process's memory
// (`authority._local_editor_mcp`); the store gets a fingerprint, not values.
const home = process.env.FAKE_HERMES_HOME ?? process.cwd();
/** @type {{ fingerprint: string | null, connections: unknown[], tools: Set<string> }} */
let editorServers = { fingerprint: null, connections: [], tools: new Set() };

function log(entry) {
  if (typeof logPath === "string") {
    appendFileSync(logPath, `${entry}\n`);
  }
}
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function result(id, value = {}) {
  send({ jsonrpc: "2.0", id, result: value });
}
function error(id, failure) {
  send({ jsonrpc: "2.0", id, error: failure });
}
function update(value, target = sessionId) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: target, update: value } });
}

/*
 * The gateway's `bind_editor_mcp` (`session/new`) and `resume_editor_mcp`
 * (`session/resume`): attach the editor's servers, or keep the session's when
 * the list is empty or unchanged. A changed list re-spawns them, because the
 * old connection holds the previous generation's env values.
 */
async function bindEditorServers(params) {
  const servers = Array.isArray(params?.mcpServers) ? params.mcpServers : [];
  // An empty or omitted list keeps the session's servers (`resume_editor_mcp`);
  // the same list keeps the held connection; a changed list swaps the values.
  const fingerprint = servers.length === 0 ? undefined : editorMcpFingerprint(servers);
  if (editorServers.fingerprint !== null && (fingerprint === undefined || fingerprint === editorServers.fingerprint)) {
    log(fingerprint === undefined ? "editor_mcp:kept" : "editor_mcp:reused");
    return;
  }
  if (servers.length === 0) { return; }
  closeEditorServers(editorServers);
  editorServers = await attachQuietly(servers);
}

/** A changed list swaps the credentials: a broken server is left out and the session continues. */
async function attachQuietly(servers) {
  try {
    return await attachEditorServers({ servers, home, log });
    // oxlint-disable-next-line eslint/no-shadow -- `error` is this fixture's JSON-RPC error responder; the catch parameter shadows it inside the handler only.
  } catch (error) {
    log(`editor_mcp:discovery_failed:${error instanceof Error ? error.message : String(error)}`);
    return { fingerprint: editorMcpFingerprint(servers), connections: [], tools: new Set() };
  }
}

function configOptions() {
  if (process.env.FAKE_HERMES_CONFIG_OPTIONS !== undefined) {
    return JSON.parse(process.env.FAKE_HERMES_CONFIG_OPTIONS);
  }
  const options = [
    {
      currentValue: currentMode,
      options: [
        { name: "Default", value: "ask" },
        { name: "Accept Edits", value: "workspace_session" },
        { name: "Don't Ask", value: "session" },
      ],
      category: "mode",
      id: "edit_approval_policy",
      name: "Edits",
      type: "select",
    },
    {
      currentValue: currentEffort,
      options: ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map((value) => ({ name: value, value })),
      category: "thought_level",
      id: "reasoning_effort",
      name: "Reasoning effort",
      type: "select",
    },
  ];
  if (models !== undefined) {
    options.push({
      currentValue: currentModel,
      options: models.availableModels.map((entry) => ({ name: entry.name, value: entry.modelId })),
      category: "model",
      id: "model",
      name: "Model",
      type: "select",
    });
  }
  return options;
}

function modes() {
  return {
    availableModes: [
      { description: "Ask before edits.", id: "default", name: "Default" },
      { description: "Auto-allow workspace and temp-dir edits; still asks for sensitive paths.", id: "accept_edits", name: "Accept Edits" },
      { description: "Auto-allow file edits for this session except sensitive paths.", id: "dont_ask", name: "Don't Ask" },
    ],
    currentModeId: currentMode,
  };
}

function sessionFields() {
  return {
    ...(models === undefined ? {} : { models: { ...models, currentModelId: currentModel } }),
    configOptions: configOptions(),
    modes: modes(),
    _meta: {
      hermes: {
        sessionProvenance: {
          acpSessionId: sessionId,
          currentHermesSessionId: sessionId,
          rootHermesSessionId: sessionId,
          parentHermesSessionId: null,
          sessionKind: "root",
          compressionDepth: 0,
        },
      },
    },
  };
}

function afterAttach() {
  // The gateway schedules these after the open reply (gateway_server._after_attach).
  setImmediate(() => {
    if (process.env.FAKE_HERMES_NO_COMMANDS !== "1") {
      update({
        availableCommands: [{ name: "compress", description: "Compress the conversation" }],
        sessionUpdate: "available_commands_update",
      });
    }
    update({ configOptions: configOptions(), sessionUpdate: "config_option_update" });
  });
}

/**
 * The model asked for the session MCP tool: the owner calls it and the tool's
 * own answer becomes part of this turn's text. A prompt naming the echo makes
 * the tool answer with the env value it was started under.
 */
async function toolText(text) {
  const echoToken = text.includes("echo");
  const answered = await callEditorTool({ holder: editorServers, tool: "probe_echo", args: { text: "hello", echoToken }, log });
  return `tool:${answered}`;
}

async function completePrompt(id, text) {
  if (text === "cancel") {
    result(id, { stopReason: "cancelled" });
    update({ sessionUpdate: "usage_update", used: 200, size: 1000 });
    return;
  }
  const body = typeof text === "string" && text.startsWith("call-tool") ? await toolText(text) : `echo:${String(text)}`;
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: body } });
  update({ sessionUpdate: "usage_update", used: 300, size: 1000 });
  // Session-cumulative counters, as gateway_session_meta.turn_usage reports
  // them; OAR does not map these as per-prompt tokens.
  result(id, {
    stopReason: "end_turn",
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, thoughtTokens: 5, cachedReadTokens: 10 },
  });
}

function handlePrompt(message) {
  const prompt = Array.isArray(message.params?.prompt) ? message.params.prompt : [];
  const text = prompt.find((block) => block?.type === "text")?.text ?? "";
  log(`prompt:${text}`);
  if (text === "hold" || text === "cancel") {
    pendingPrompts.set(message.id, text);
    pending.set(message.id, message.id);
    return;
  }
  queueMicrotask(() => { void completePrompt(message.id, text); });
}

function handleCancel(message) {
  log("cancel");
  for (const id of pendingPrompts.keys()) {
    pendingPrompts.delete(id);
    result(id, { stopReason: "cancelled" });
  }
  pending.clear();
  result(message.id, {});
}

function initializeResult(id) {
  log("initialize");
  const meta = {
    ...(process.env.FAKE_HERMES_STEER === undefined ? {} : { "hermes/steer": true }),
    ...(process.env.FAKE_HERMES_COMPACT === undefined ? {} : { "hermes/compact": true }),
  };
  result(id, {
    protocolVersion: 1,
    ...(Object.keys(meta).length === 0 ? {} : { _meta: meta }),
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true },
      sessionCapabilities: { fork: {}, list: {}, resume: {} },
    },
    agentInfo: { name: "hermes-agent", version: "0.23.3" },
    authMethods: [
      {
        args: ["--setup"],
        description: "Open Hermes' interactive model/provider setup in a terminal. Use this when Hermes has not been configured on this machine yet.",
        id: "hermes-setup",
        name: "Configure Hermes provider",
        type: "terminal",
      },
    ],
  });
}
async function resumeResult(message) {
  log(message.method);
  if (process.env.FAKE_HERMES_RESUME_ERROR !== undefined) {
    const failure = JSON.parse(process.env.FAKE_HERMES_RESUME_ERROR);
    error(message.id, { code: failure.code, message: failure.message, ...(failure.data === undefined ? {} : { data: failure.data }) });
    return;
  }
  await bindEditorServers(message.params);
  result(message.id, sessionFields());
  afterAttach();
}
function configResult(message) {
  log(`set_config_option:${message.params?.configId}=${message.params?.value}`);
  if (message.params?.configId === "model") {
    currentModel = String(message.params?.value ?? currentModel);
  } else if (message.params?.configId === "reasoning_effort") {
    currentEffort = String(message.params?.value ?? currentEffort);
  } else if (message.params?.configId === "edit_approval_policy") {
    currentMode = String(message.params?.value ?? currentMode);
  }
  result(message.id, { configOptions: configOptions() });
}
// The gateway discovers the editor's servers before it answers `session/new`
// (`bind_editor_mcp` inside `session.create`), so the reply waits for them.
async function newSession(message) {
  log("session/new");
  await bindEditorServers(message.params);
  result(message.id, { sessionId, ...sessionFields() });
  afterAttach();
}

function handleCompact(message) {
  log(`compact:${message.params?.sessionId}`);
  const mode = process.env.FAKE_HERMES_COMPACT;
  if (mode === "committed") {
    result(message.id, { status: "committed", revision: 2, execution_generation: 2, target_session_id: "local-compacted-target" });
  } else if (mode === "noop") {
    result(message.id, { status: "noop" });
  } else if (mode === "refused") {
    result(message.id, { status: "refused", reason: "session_busy" });
  } else if (mode === "malformed") {
    result(message.id, { status: "committed" });
  } else {
    error(message.id, { code: -32_601, message: "unknown method: hermes/session/compact" });
  }
}

function handleSteer(message) {
  log(`steer:${message.params.sessionId}:${message.params.text}`);
  if (process.env.FAKE_HERMES_STEER === "lost") {
    error(message.id, { code: -32_603, message: "Internal error" });
  } else if (pendingPrompts.size === 0 || process.env.FAKE_HERMES_STEER === "idle") {
    result(message.id, { status: "no_active_turn" });
  } else {
    result(message.id, { status: "queued" });
    for (const id of pendingPrompts.keys()) {
      pendingPrompts.delete(id);
      void completePrompt(id, message.params.text);
    }
  }
}

function handleRequest(message) {
  switch (message.method) {
    case "initialize": initializeResult(message.id); break;
    case "authenticate": log("authenticate"); result(message.id, {}); break;
    case "session/new": newSession(message); break;
    case "session/resume":
    case "session/load": resumeResult(message); break;
    case "session/fork": log("session/fork"); result(message.id, { sessionId: `${sessionId}-fork`, ...sessionFields() }); break;
    case "session/list": log("session/list"); result(message.id, { sessions: [] }); break;
    case "session/set_model": log(`set_model:${message.params?.modelId}`); currentModel = String(message.params?.modelId ?? currentModel); result(message.id, {}); break;
    case "session/set_mode": log(`set_mode:${message.params?.modeId}`); currentMode = String(message.params?.modeId ?? currentMode); result(message.id, {}); break;
    case "session/set_config_option": configResult(message); break;
    case "session/prompt": handlePrompt(message); break;
    case "_hermes/session/steer": handleSteer(message); break;
    case "_hermes/session/compact": handleCompact(message); break;
    case "session/cancel": handleCancel(message); break;
    default: error(message.id, { code: -32_601, message: `unknown method: ${message.method}` }); break;
  }
}

const reader = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "session/cancel") {
    log("cancel");
    for (const id of pendingPrompts.keys()) {
      pendingPrompts.delete(id);
      result(id, { stopReason: "cancelled" });
    }
    return;
  }
  if (message.method !== undefined) {
    handleRequest(message);
  }
});
