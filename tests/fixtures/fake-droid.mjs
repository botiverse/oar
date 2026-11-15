// oxlint-disable -- A stand-in executable, deliberately untyped like the protocol it fakes.
// A stand-in `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`
// (droid 1.12.1, protocol 1.340.0). FAKE_DROID_MODE selects a native behavior:
// - (unset): each user message runs a turn that answers "ok" and ends after FAKE_DROID_TURN_MS (default 0);
// - missed-steer: a message during a turn ends that turn at once without taking it,
//   then runs it as a turn of its own (droid's steer that missed its turn's end);
// - handback: prompts are never echoed, and an interrupt hands the running prompt back and never ends its turn;
// - stuck: an interrupt is acknowledged and the turn never ends;
// - noisy: a non-JSON line and a response nobody asked for at startup, and get_context_stats fails.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_DROID_MODE ?? "";
const turnMs = Number(process.env.FAKE_DROID_TURN_MS ?? "0");
const envelope = { jsonrpc: "2.0", factoryApiVersion: "1.0.0", factoryProtocolVersion: "1.340.0" };
const write = (message) => { process.stdout.write(`${JSON.stringify({ ...envelope, ...message })}\n`); };
const note = (notification) => { write({ type: "notification", method: "droid.session_notification", params: { sessionId, notification } }); };
let sessionId = randomUUID();
const efforts = new Set(["low", "medium", "high"]);
const settings = { modelId: "gpt-6.1-sol", reasoningEffort: "high", autonomyLevel: "medium" };
/** The running turn: its id, the RPC id of the message that started it, and its pending end. */
let running = null;

function endTurn(reason = "completed") {
  if (running === null) { return; }
  clearTimeout(running.timer);
  const { turnId } = running;
  running = null;
  note({ type: "agent_turn_completed", reason, turnId, tokenUsage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 } });
  note({ type: "droid_working_state_changed", newState: "idle", backgroundWork: 0 });
}

function startTurn(rpcId, messageId, text, ms = turnMs) {
  running = { turnId: messageId, rpcId, timer: null };
  note({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
  // handback: droid has not taken the prompt yet (no echo), as when an interrupt arrives right after it.
  if (mode !== "handback") { note({ type: "create_message", requestId: rpcId, message: { id: messageId, role: "user", content: [{ type: "text", text }] } }); }
  note({ type: "assistant_text_delta", messageId: `a-${messageId}`, blockIndex: 0, textDelta: "ok" });
  running.timer = setTimeout(() => { endTurn(); }, ms);
}

if (mode === "noisy") {
  process.stdout.write("droid: not a JSON line\n");
  write({ type: "response", id: "nobody-asked", result: {} });
}

// Like droid, it ends when its stdin closes (OAR's graceful stop).
const input = createInterface({ input: process.stdin });
input.on("close", () => { process.exit(0); });
input.on("line", (line) => {
  const message = JSON.parse(line);
  const reply = (result) => { write({ type: "response", id: message.id, result }); };
  switch (message.method) {
    case "droid.initialize_session":
    case "droid.load_session":
      if (message.params.reasoningEffort !== undefined && !efforts.has(message.params.reasoningEffort)) {
        write({ type: "response", id: message.id, error: { code: -32_602, message: `Invalid request for ${message.method}: params.reasoningEffort: Invalid enum value. Expected 'low' | 'medium' | 'high', received '${message.params.reasoningEffort}'` } });
        return;
      }
      // droid runs its default in place of a model it does not know, without an error.
      if (message.params.modelId === "no-such-model") { message.params.modelId = "gpt-6.1-sol"; }
      sessionId = message.params.sessionId ?? sessionId;
      Object.assign(settings, message.params.modelId ? { modelId: message.params.modelId } : {}, message.params.reasoningEffort ? { reasoningEffort: message.params.reasoningEffort } : {});
      note({ type: "settings_updated", settings });
      reply({ sessionId, session: { messages: [] }, settings, ...(message.params.cwd ? {} : { cwd: process.cwd() }) });
      return;
    case "droid.update_session_settings":
      Object.assign(settings, message.params);
      reply({});
      note({ type: "settings_updated", settings });
      return;
    case "droid.add_user_message":
      reply({});
      if (running === null) { startTurn(message.id, message.params.messageId, message.params.text); return; }
      if (mode === "missed-steer") {
        // The steer arrives as the turn ends: droid ends the turn without it, then runs it on its own.
        endTurn();
        setTimeout(() => { startTurn(message.id, message.params.messageId, message.params.text, 300); }, 300);
        return;
      }
      note({ type: "create_message", requestId: message.id, message: { id: message.params.messageId, role: "user", content: [{ type: "text", text: message.params.text }] } });
      return;
    case "droid.interrupt_session":
      reply({});
      if (running === null) { return; }
      if (mode === "handback") {
        clearTimeout(running.timer);
        note({ type: "queued_message_handed_back", requestId: running.rpcId, text: "handed back" });
        running = null;
        return;
      }
      if (mode === "stuck") { clearTimeout(running.timer); running = { ...running, timer: null }; return; }
      endTurn("cancelled");
      return;
    case "droid.get_context_stats":
      if (mode === "noisy") { write({ type: "response", id: message.id, error: { code: -32_603, message: "context unavailable" } }); return; }
      reply({ used: 10, remaining: 90, limit: 100, accuracy: "estimated", updatedAt: new Date().toISOString() });
      return;
    case "droid.list_models":
      reply({ models: [{ id: "gpt-6.1-sol", displayName: "GPT 6.1 Sol", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" }] });
      return;
    default:
      if (message.type === "request") { reply({}); }
  }
});
