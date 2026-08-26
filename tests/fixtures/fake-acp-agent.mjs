/* oxlint-disable eslint/max-statements, eslint/max-params, eslint/max-lines-per-function, eslint/prefer-destructuring, eslint/no-underscore-dangle, import/no-nodejs-modules, unicorn/numeric-separators-style, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/no-confusing-void-expression -- Standalone untyped child-process fixture for exercising raw ACP framing. */
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "session";
const pendingPrompts = new Map();
const reverseRequests = new Map();
let reverseId = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value = {}) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message, data) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

function update(value) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "fake-session", update: value },
  });
}

function promptText(params) {
  const prompt = Array.isArray(params?.prompt) ? params.prompt : [];
  const first = prompt[0];
  return typeof first?.text === "string" ? first.text : "";
}

function completePrompt(id, text) {
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `echo:${text}` },
  });
  update({ sessionUpdate: "usage_update", used: 250, size: 1000 });
  result(id, { stopReason: "end_turn" });
}

function handleRpcRequest(message) {
  switch (message.method) {
    case "test/echo":
      result(message.id, message.params);
      break;
    case "test/notify":
      send({ jsonrpc: "2.0", method: "fixture/notification", params: { value: 42 } });
      result(message.id);
      break;
    case "test/reverse": {
      reverseId += 1;
      const id = `reverse-${reverseId}`;
      reverseRequests.set(id, { kind: "rpc", outerId: message.id });
      send({
        jsonrpc: "2.0",
        id,
        method: "fixture/reverse",
        params: { question: "answer me" },
      });
      break;
    }
    case "test/timeout":
      break;
    case "test/exit":
      process.exit(7);
      break;
    case "test/invalid":
      process.stdout.write("this is not json\n");
      break;
    default:
      error(message.id, -32601, `unknown test method: ${message.method}`);
      break;
  }
}

function handleSessionPrompt(message) {
  const text = promptText(message.params);
  if (text === "hold" || text === "steer-base") {
    pendingPrompts.set(message.id, text);
    return;
  }
  if (text === "steer-new" && message.params?._meta?.sendNow === true) {
    for (const id of pendingPrompts.keys()) {
      result(id, { stopReason: "cancelled", _meta: { cancelTrigger: "send_now" } });
    }
    pendingPrompts.clear();
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "steer:steer-new" },
    });
    result(message.id, { stopReason: "end_turn" });
    return;
  }
  if (text === "tool") {
    update({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "inspect" },
    });
    update({
      sessionUpdate: "tool_call",
      toolCallId: "call-read",
      toolName: "Read",
      kind: "read",
      title: "Read input.txt",
      status: "pending",
      rawInput: { path: "input.txt" },
    });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-read",
      status: "in_progress",
    });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-read",
      status: "completed",
      rawOutput: { content: "fixture-value" },
    });
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "tool-done" },
    });
    update({ sessionUpdate: "usage_update", used: 500, size: 2000 });
    result(message.id, { stopReason: "end_turn" });
    return;
  }
  if (text === "permission") {
    reverseId += 1;
    const id = `permission-${reverseId}`;
    reverseRequests.set(id, { kind: "permission", outerId: message.id });
    send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: "fake-session",
        options: [
          { optionId: "once", kind: "allow_once", name: "Allow once" },
          { optionId: "always", kind: "allow_always", name: "Always allow" },
          { optionId: "reject", kind: "reject_once", name: "Reject" },
        ],
      },
    });
    return;
  }
  if (text === "fail") {
    error(message.id, -32000, "Authentication required");
    return;
  }
  if (text === "exit") {
    process.exit(9);
    return;
  }
  queueMicrotask(() => completePrompt(message.id, text));
}

function handleSessionRequest(message) {
  switch (message.method) {
    case "initialize":
      result(message.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, close: {} },
        },
        authMethods: [{ id: "cached", name: "Cached login" }],
      });
      break;
    case "authenticate":
      result(message.id);
      break;
    case "session/new":
      result(message.id, {
        sessionId: "fake-session",
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "yolo", name: "YOLO" },
          ],
        },
      });
      break;
    case "session/resume":
    case "session/load":
      result(message.id, {
        modes: {
          currentModeId: "default",
          availableModes: [{ id: "yolo", name: "YOLO" }],
        },
      });
      break;
    case "session/set_model":
    case "session/set_mode":
      result(message.id);
      break;
    case "session/prompt":
      handleSessionPrompt(message);
      break;
    case "session/close":
      send({ jsonrpc: "2.0", method: "fixture/closed", params: message.params });
      result(message.id);
      break;
    default:
      error(message.id, -32601, `unknown ACP method: ${message.method}`);
      break;
  }
}

function handleResponse(message) {
  const pending = reverseRequests.get(message.id);
  if (pending === undefined) {
    return;
  }
  reverseRequests.delete(message.id);
  if (pending.kind === "rpc") {
    result(pending.outerId, { reverse: message.result });
    return;
  }
  const optionId = message.result?.outcome?.optionId ?? "cancelled";
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `permission:${optionId}` },
  });
  result(pending.outerId, { stopReason: "end_turn" });
}

function handleNotification(message) {
  if (message.method === "session/cancel") {
    for (const id of pendingPrompts.keys()) {
      result(id, { stopReason: "cancelled" });
    }
    pendingPrompts.clear();
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && typeof message.method !== "string") {
    handleResponse(message);
    return;
  }
  if (message.id === undefined) {
    handleNotification(message);
    return;
  }
  if (mode === "rpc") {
    handleRpcRequest(message);
  } else {
    handleSessionRequest(message);
  }
});
