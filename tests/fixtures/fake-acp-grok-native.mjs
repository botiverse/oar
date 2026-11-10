/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function, eslint/no-underscore-dangle, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped child-process fixture. */
/*
 * Mode "grok-native": Grok's own prompt queue and interjections, in the shapes
 * Grok 1.0.77 sent (experiments/grok-interject/README.md): `_meta.promptId`
 * names the prompt; `_x.ai/queue/changed` holds then runs it; `turn_completed`
 * closes it by `prompt_id` before the RPC answer; `_x.ai/interject` answers
 * `{result: {status: "queued"}}` and echoes `_x.ai/session/interjection`.
 */
const SESSION = "fake-session";
let running = null;
let buffered = [];
let fallbacks = 0;

function vendor(send, update) {
  send({ jsonrpc: "2.0", method: "_x.ai/session_notification", params: { sessionId: SESSION, update } });
}
function queueChanged(send, run) {
  send({ jsonrpc: "2.0", method: "_x.ai/queue/changed", params: { sessionId: SESSION, entries: [], ...(run === null ? {} : { runningPromptId: run }) } });
}
function chunk(send, text) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
}
const usage = { inputTokens: 10, outputTokens: 1 };

/** Grok's own turn: no RPC, closed only by its own turn_completed. */
function ownTurn(send, promptId, text) {
  queueChanged(send, promptId);
  chunk(send, text);
  queueChanged(send, null);
  send({ jsonrpc: "2.0", method: "_x.ai/session_notification", params: { sessionId: SESSION, _meta: { eventId: `own-${promptId}` }, update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn", usage } } });
}

function finish(send, result, stopReason = "end_turn") {
  const current = running;
  running = null;
  queueChanged(send, null);
  vendor(send, { sessionUpdate: "turn_completed", prompt_id: current.promptId, stop_reason: stopReason });
  result(current.id, { stopReason, _meta: { promptId: current.promptId } });
}

function grokNativePrompt(message, { send, result }) {
  const promptId = message.params?._meta?.promptId ?? "unnamed";
  const text = message.params?.prompt?.find((block) => block?.type === "text")?.text ?? "";
  send({ jsonrpc: "2.0", method: "_x.ai/queue/changed", params: { sessionId: SESSION, entries: [{ id: promptId, kind: "prompt", text }] } });
  queueChanged(send, promptId);
  running = { id: message.id, promptId, text };
  if (text === "hold" || text === "hold-buffer") { return; }
  chunk(send, `echo:${text}`);
  if (text === "race-long") {
    const current = running;
    running = { id: null, promptId: "subagent-completed-long", own: true };
    queueChanged(send, null);
    vendor(send, { sessionUpdate: "turn_completed", prompt_id: current.promptId, stop_reason: "end_turn" });
    queueChanged(send, running.promptId);
    chunk(send, "woke-long");
    result(current.id, { stopReason: "end_turn", _meta: { promptId: current.promptId } });
    // Native work can continue while its predecessor's RPC has already settled.
    setTimeout(() => {
      queueChanged(send, null);
      vendor(send, { sessionUpdate: "turn_completed", prompt_id: "subagent-completed-long", stop_reason: "end_turn" });
      running = null;
    }, 500);
    return;
  }
  if (text === "race") {
    // Grok's next turn starts as soon as this one ends; its frames can reach
    // OAR before the prompt answer is recorded.
    const current = running;
    running = null;
    queueChanged(send, null);
    vendor(send, { sessionUpdate: "turn_completed", prompt_id: current.promptId, stop_reason: "end_turn" });
    ownTurn(send, "subagent-completed-race", "woke-race");
    result(current.id, { stopReason: "end_turn", _meta: { promptId: current.promptId } });
    return;
  }
  if (text === "late-drain") {
    // Grok's turn is over (its final drain has passed) but the answer is still
    // on its way: an interjection now misses the turn and runs on its own.
    const current = running;
    running = null;
    queueChanged(send, null);
    vendor(send, { sessionUpdate: "turn_completed", prompt_id: current.promptId, stop_reason: "end_turn" });
    setTimeout(() => { result(current.id, { stopReason: "end_turn", _meta: { promptId: current.promptId } }); }, 80);
    return;
  }
  finish(send, result);
  if (text === "wake") {
    setTimeout(() => {
      queueChanged(send, "subagent-completed-child");
      chunk(send, "woke");
      // Held open until the test interjects or a later wake-end request arrives.
      running = { id: null, promptId: "subagent-completed-child", own: true };
    }, 20);
  }
}

function grokNativeInterject(message, { send, result }) {
  const text = message.params?.text;
  result(message.id, { result: { status: "queued" } });
  send({ jsonrpc: "2.0", method: "_x.ai/session/interjection", params: { sessionId: SESSION, text, interjectionId: message.params?.interjectionId } });
  if (running === null) {
    fallbacks += 1;
    ownTurn(send, `interject-fallback-${fallbacks}`, `took:${text}`);
    return;
  }
  if (running.text === "hold-buffer") { buffered.push(text); return; }
  chunk(send, `took:${text}`);
  if (running.own === true) {
    const current = running;
    running = null;
    queueChanged(send, null);
    send({ jsonrpc: "2.0", method: "_x.ai/session_notification", params: { sessionId: SESSION, _meta: { eventId: `own-${current.promptId}` }, update: { sessionUpdate: "turn_completed", prompt_id: current.promptId, stop_reason: "end_turn", usage } } });
    return;
  }
  finish(send, result);
}

/** session/cancel clears buffered interjections ("Clear, don't flush") and cancels the prompt. */
function grokNativeCancel(send, result) {
  buffered = [];
  if (running?.own === true) {
    const current = running;
    running = null;
    queueChanged(send, null);
    send({ jsonrpc: "2.0", method: "_x.ai/session_notification", params: { sessionId: SESSION, _meta: { eventId: `cancel-${current.promptId}` }, update: { sessionUpdate: "turn_completed", prompt_id: current.promptId, stop_reason: "cancelled" } } });
  } else if (running !== null) { finish(send, result, "cancelled"); }
}

/** Handle what mode "grok-native" answers itself; false leaves the message to the generic fixture. */
export default function grokNative(message, { send, result }) {
  if (message.method === "session/prompt") { grokNativePrompt(message, { send, result }); return true; }
  if (message.method === "_x.ai/interject") { grokNativeInterject(message, { send, result }); return true; }
  if (message.method === "session/cancel") { grokNativeCancel(send, result); return true; }
  return false;
}
