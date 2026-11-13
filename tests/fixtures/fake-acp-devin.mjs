/* oxlint-disable import/no-nodejs-modules, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-return -- Standalone ACP wire fixture. */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = process.env.FAKE_DEVIN_CALL_LOG;
const args = process.argv.slice(2);
let currentMode = "accept-edits";
let currentModel = "claude-sonnet-4-5";
let currentEffort = "medium";

function logCall(entry) {
  if (typeof logPath === "string") {
    appendFileSync(logPath, `${entry}\n`);
  }
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function availableModes() {
  const base = [{ id: "accept-edits", name: "Accept Edits" }, { id: "plan", name: "Plan" }];
  return process.env.FAKE_DEVIN_ADVERTISE_BYPASS === "1" ? [...base, { id: "bypass", name: "Bypass" }] : base;
}

function configOptions() {
  if (process.env.FAKE_DEVIN_CONFIG_OPTIONS !== undefined) {
    return JSON.parse(process.env.FAKE_DEVIN_CONFIG_OPTIONS);
  }
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: [{ value: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }, { value: "gpt-5", name: "GPT-5" }],
    },
    {
      id: "thought_level",
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      currentValue: currentEffort,
      options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }],
    },
  ];
}

function handleSetConfigOption(req) {
  if (req.params?.configId === "model") {
    currentModel = String(req.params.value);
  } else if (req.params?.configId === "thought_level") {
    currentEffort = String(req.params.value);
  } else {
    send({ jsonrpc: "2.0", id: req.id, error: { code: -32_602, message: "Invalid params" } });
    return;
  }
  const next = configOptions();
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "devin-sess-1", update: { sessionUpdate: "config_option_update", configOptions: next } } });
  send({ jsonrpc: "2.0", id: req.id, result: { configOptions: next } });
}

function handleSessionNew(req) {
  if (process.env.FAKE_DEVIN_NEW_ERROR !== undefined) {
    send({ jsonrpc: "2.0", id: req.id, error: JSON.parse(process.env.FAKE_DEVIN_NEW_ERROR) });
    return;
  }
  send({
    jsonrpc: "2.0",
    id: req.id,
    result: {
      sessionId: process.env.FAKE_DEVIN_SESSION_ID ?? "devin-sess-1",
      modes: { currentModeId: currentMode, availableModes: availableModes() },
      configOptions: configOptions(),
    },
  });
}

const methodHandlers = {
  initialize: (req) => {
    send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } } } });
  },
  "session/new": handleSessionNew,
  "session/list": (req) => {
    const cwd = process.env.FAKE_DEVIN_SESSION_CWD ?? process.cwd();
    send({ jsonrpc: "2.0", id: req.id, result: { sessions: [{ sessionId: "devin-sess-1", cwd }] } });
  },
  "session/load": (req) => {
    send({ jsonrpc: "2.0", id: req.id, result: { modes: { currentModeId: currentMode, availableModes: availableModes() }, configOptions: configOptions() } });
  },
  "session/set_mode": (req) => {
    currentMode = String(req.params?.modeId ?? currentMode);
    logCall(`mode:${currentMode}`);
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  },
  "session/set_config_option": handleSetConfigOption,
  "session/prompt": (req) => {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "devin-sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `mode:${currentMode}` } } } });
    send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
  },
  "session/close": (req) => {
    logCall(`close:${String(req.params?.sessionId ?? "")}`);
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  },
};

function handleRequest(req) {
  logCall(String(req.method));
  const handler = methodHandlers[String(req.method)];
  if (handler !== undefined) {
    handler(req);
    return;
  }
  send({ jsonrpc: "2.0", id: req.id, error: { code: -32_601, message: "Method not found" } });
}

if (args[0] === "auth" && args[1] === "status") {
  logCall("auth status");
  process.stdout.write(process.env.FAKE_DEVIN_AUTH_STDOUT ?? "Not logged in.\n");
  process.exit(0);
}
if (args.includes("acp") === false) {
  process.exit(2);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.id !== undefined) {
    handleRequest(req);
  }
});
