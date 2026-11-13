/* oxlint-disable import/no-nodejs-modules, eslint/no-underscore-dangle, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-return -- Standalone ACP wire fixture replaying devin 3000.12.57 payloads. */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.FAKE_DEVIN_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
}

const logPath = process.env.FAKE_DEVIN_CALL_LOG;
const args = process.argv.slice(2);
let currentMode = "accept-edits";
let currentModel = "swe-1-6-fast";
let currentEffort = "medium";
let activeSessionId = process.env.FAKE_DEVIN_SESSION_ID ?? "devin-sess-1";
const sessions = new Map([
  ["devin-sess-1", { cwd: process.env.FAKE_DEVIN_SESSION_CWD ?? process.cwd() }],
]);

const ALL_MODES = [
  { id: "accept-edits", name: "Code", description: "Write and edit code", icon: "code" },
  { id: "smart", name: "Smart", description: "Auto-approve actions the model judges safe", icon: "sparkles" },
  { id: "ask", name: "Ask", description: "Answer questions without code changes", icon: "message-circle" },
  { id: "plan", name: "Plan", description: "Plan changes before implementing", icon: "file-text" },
  {
    id: "bypass",
    name: "Bypass Permissions",
    description: "Auto-approve all tool calls unless your organization's policy requires approval",
    icon: "shield-off",
  },
];

function logCall(entry) {
  if (typeof logPath === "string") {
    appendFileSync(logPath, `${entry}\n`);
  }
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function activeModes() {
  return process.env.FAKE_DEVIN_ADVERTISE_BYPASS === "0"
    ? ALL_MODES.filter((mode) => mode.id !== "bypass")
    : ALL_MODES;
}

function availableModes() {
  return activeModes().map(({ id, name }) => ({ id, name }));
}

function modeConfigOption() {
  return {
    id: "mode",
    name: "Session Mode",
    category: "mode",
    type: "select",
    currentValue: currentMode,
    options: activeModes().map((mode) => ({
      value: mode.id,
      name: mode.name,
      description: mode.description,
      _meta: { "cognition.ai/icon": mode.icon },
    })),
  };
}

function configOptions() {
  if (process.env.FAKE_DEVIN_CONFIG_OPTIONS !== undefined) {
    return JSON.parse(process.env.FAKE_DEVIN_CONFIG_OPTIONS);
  }
  return [
    modeConfigOption(),
    {
      id: "model",
      name: "Model",
      description: "AI model to use",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: [
        { value: "swe-1-6-fast", name: "SWE-1.6 Fast" },
        { value: "swe-1-6", name: "SWE-1.6" },
      ],
    },
    {
      id: "thought_level",
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      currentValue: currentEffort,
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ];
}

function initializeResult() {
  const sessionCapabilities = process.env.FAKE_DEVIN_SESSION_CAPABILITIES === undefined
    ? { list: {}, delete: {}, additionalDirectories: {}, close: { _meta: { "cognition.ai/force": true } } }
    : JSON.parse(process.env.FAKE_DEVIN_SESSION_CAPABILITIES);
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities,
      auth: {},
      _meta: {
        "cognition.ai/sessionDefaultConfigOptions": true,
        "cognition.ai/multiRootWorkspace": true,
        "cognition.ai/sessionRename": true,
        "cognition.ai/persistOnCreate": true,
        "cognition.ai/midTurnPrompts": true,
      },
    },
    authMethods: [{ id: "devin-browser", name: "Log in with browser", description: "Sign in via your browser" }],
    agentInfo: { name: "affogato", title: "Devin Agent", version: "0.0.0-dev" },
  };
}

function handleSetConfigOption(req) {
  if (req.params?.configId === "model") {
    currentModel = String(req.params.value);
  } else if (req.params?.configId === "thought_level") {
    currentEffort = String(req.params.value);
  } else if (req.params?.configId === "mode") {
    currentMode = String(req.params.value);
  } else {
    send({ jsonrpc: "2.0", id: req.id, error: { code: -32_602, message: "Invalid params" } });
    return;
  }
  const next = configOptions();
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: activeSessionId, update: { sessionUpdate: "config_option_update", configOptions: next } },
  });
  send({ jsonrpc: "2.0", id: req.id, result: { configOptions: next } });
}

function handleSessionNew(req) {
  if (process.env.FAKE_DEVIN_NEW_ERROR !== undefined) {
    send({ jsonrpc: "2.0", id: req.id, error: JSON.parse(process.env.FAKE_DEVIN_NEW_ERROR) });
    return;
  }
  const sessionId = process.env.FAKE_DEVIN_SESSION_ID ?? "devin-sess-1";
  activeSessionId = sessionId;
  sessions.set(sessionId, { cwd: String(req.params?.cwd ?? process.cwd()) });
  send({
    jsonrpc: "2.0",
    id: req.id,
    result: {
      sessionId,
      modes: { currentModeId: currentMode, availableModes: availableModes() },
      configOptions: configOptions(),
      _meta: { "cognition.ai/isLocked": false, "cognition.ai/lockHolderPid": null },
    },
  });
}

function handleSessionLoad(req) {
  if (process.env.FAKE_DEVIN_LOAD_ERROR !== undefined) {
    send({ jsonrpc: "2.0", id: req.id, error: JSON.parse(process.env.FAKE_DEVIN_LOAD_ERROR) });
    return;
  }
  const sessionId = String(req.params?.sessionId ?? "");
  if (!sessions.has(sessionId) || process.env.FAKE_DEVIN_MISSING_LOAD === "1") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32_016,
        message: "Session not found",
        data: { "cognition.ai/errorKind": "session_not_found", "cognition.ai/retryable": false },
      },
    });
    return;
  }
  activeSessionId = sessionId;
  send({
    jsonrpc: "2.0",
    id: req.id,
    result: {
      modes: { currentModeId: currentMode, availableModes: availableModes() },
      configOptions: configOptions(),
    },
  });
}

function handleSessionPrompt(req) {
  if (process.env.FAKE_DEVIN_PROMPT_ERROR !== undefined) {
    send({ jsonrpc: "2.0", id: req.id, error: JSON.parse(process.env.FAKE_DEVIN_PROMPT_ERROR) });
    return;
  }
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: activeSessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `mode:${currentMode}` } },
    },
  });
  send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
}

const methodHandlers = {
  initialize: (req) => {
    send({ jsonrpc: "2.0", id: req.id, result: initializeResult() });
  },
  "session/new": handleSessionNew,
  "session/list": (req) => {
    const listed = [...sessions.entries()].map(([sessionId, info]) => ({ sessionId, cwd: info.cwd }));
    send({ jsonrpc: "2.0", id: req.id, result: { sessions: listed } });
  },
  "session/load": handleSessionLoad,
  "session/set_mode": (req) => {
    currentMode = String(req.params?.modeId ?? currentMode);
    logCall(`mode:${currentMode}`);
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  },
  "session/set_config_option": handleSetConfigOption,
  "session/prompt": handleSessionPrompt,
  "session/delete": (req) => {
    const sessionId = String(req.params?.sessionId ?? "");
    sessions.delete(sessionId);
    logCall(`delete:${sessionId}`);
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  },
  "session/close": (req) => {
    logCall(`close:${String(req.params?.sessionId ?? "")}`);
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  },
};

function dispatchRequest(method, req) {
  const handler = methodHandlers[method];
  if (handler !== undefined) {
    handler(req);
    return;
  }
  send({ jsonrpc: "2.0", id: req.id, error: { code: -32_601, message: "Method not found" } });
}

function handleRequest(req) {
  const method = String(req.method);
  logCall(method);
  if (process.env.FAKE_DEVIN_STALL_METHOD === method) {
    return;
  }
  const stepDelayMs = Number(process.env.FAKE_DEVIN_STEP_DELAY_MS ?? "0");
  if (stepDelayMs > 0) {
    setTimeout(() => { dispatchRequest(method, req); }, stepDelayMs);
    return;
  }
  dispatchRequest(method, req);
}

function finishAuthStatus() {
  process.stdout.write(process.env.FAKE_DEVIN_AUTH_STDOUT ?? "Not logged in.\n");
  process.exit(Number(process.env.FAKE_DEVIN_AUTH_EXIT_CODE ?? "0"));
}

if (args[0] === "auth" && args[1] === "status") {
  logCall("auth status");
  const authDelayMs = Number(process.env.FAKE_DEVIN_AUTH_DELAY_MS ?? "0");
  if (authDelayMs > 0) {
    setTimeout(finishAuthStatus, authDelayMs);
  } else {
    finishAuthStatus();
  }
} else if (args.includes("acp") === false) {
  process.exit(2);
} else {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const req = JSON.parse(line);
    if (req.id !== undefined) {
      handleRequest(req);
    }
  });
}
