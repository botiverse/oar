// oxlint-disable -- A stand-in executable, deliberately untyped like the protocol it fakes.
// A stand-in `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`
// (droid 1.12.1, protocol 1.340.0). FAKE_DROID_MODE selects a native behavior:
// - (unset): each user message runs a turn that answers "ok" and ends after FAKE_DROID_TURN_MS (default 0);
// - missed-steer: a message during a turn ends that turn at once without taking it,
//   then runs it as a turn of its own (droid's steer that missed its turn's end);
// - handback: prompts are never echoed, and an interrupt hands the running prompt back and never ends its turn;
// - stuck: an interrupt is acknowledged and the turn never ends;
// - missed-steer-handback: like missed-steer, but an interrupt in the gap hands the steer back,
//   and that steer's cancelled turn end comes 1.5 s later (droid 1.12.1 sends it about 20 ms later);
// - refuse-steer: a message during a turn is refused, and the refusal and the turn's end arrive in one write;
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
/** A steer that missed its turn's end, waiting to run as its own turn. */
let missed = null;
let unsolicited = false;
let contextReads = 0;

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
      if (mode === "ended-at-open") { note({ type: "agent_turn_completed", reason: "completed", turnId: "previous" }); }
      note({ type: "settings_updated", settings });
      reply({ sessionId, session: { messages: [] }, settings, ...(message.params.cwd ? {} : { cwd: process.env.FAKE_DROID_MODE === "other-cwd" ? "/saved/elsewhere" : process.cwd() }) });
      return;
    case "droid.update_session_settings":
      Object.assign(settings, message.params);
      reply({});
      note({ type: "settings_updated", settings });
      return;
    case "droid.add_user_message":
      if (running !== null && mode === "refuse-steer") {
        const { turnId } = running;
        clearTimeout(running.timer);
        running = null;
        process.stdout.write(`${JSON.stringify({ ...envelope, type: "response", id: message.id, error: { code: -32_603, message: "steer refused" } })}\n${JSON.stringify({ ...envelope, type: "notification", method: "droid.session_notification", params: { sessionId, notification: { type: "agent_turn_completed", reason: "completed", turnId } } })}\n`);
        return;
      }
      reply({});
      if (running === null) { startTurn(message.id, message.params.messageId, message.params.text); return; }
      if (mode === "missed-steer" || mode === "missed-steer-handback") {
        // The steer arrives as the turn ends: droid ends the turn without it, then runs it on its own.
        endTurn();
        missed = { rpcId: message.id, messageId: message.params.messageId, text: message.params.text,
          timer: setTimeout(() => { missed = null; startTurn(message.id, message.params.messageId, message.params.text, 300); }, 300) };
        return;
      }
      note({ type: "create_message", requestId: message.id, message: { id: message.params.messageId, role: "user", content: [{ type: "text", text: message.params.text }] } });
      return;
    case "droid.interrupt_session":
      reply({});
      if (missed !== null && mode === "missed-steer-handback") {
        const steer = missed;
        clearTimeout(steer.timer);
        missed = null;
        note({ type: "queued_message_handed_back", requestId: steer.rpcId, text: steer.text });
        setTimeout(() => { note({ type: "agent_turn_completed", reason: "cancelled", turnId: steer.messageId }); }, 1500);
        return;
      }
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
      contextReads += 1;
      if (mode === "content-before-start" && !unsolicited) {
        unsolicited = true;
        note({ type: "assistant_text_delta", messageId: "outside", blockIndex: 0, textDelta: "outside" });
        note({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
        note({ type: "assistant_text_delta", messageId: "inside", blockIndex: 0, textDelta: "inside" });
        note({ type: "agent_turn_completed", reason: "completed", turnId: "native" });
      }
      if (mode === "noisy") { write({ type: "response", id: message.id, error: { code: -32_603, message: "context unavailable" } }); return; }
      if (mode === "slow-context" && contextReads >= 2) {
        const read = contextReads;
        setTimeout(() => { reply({ used: read * 25, remaining: 100 - read * 25, limit: 100, accuracy: "exact", updatedAt: new Date().toISOString() }); }, Number(process.env.FAKE_DROID_CONTEXT_MS ?? "60"));
        return;
      }
      reply({ used: contextReads === 1 ? 10 : contextReads * 25, remaining: 90, limit: 100, accuracy: "estimated", updatedAt: new Date().toISOString() });
      return;
    case "droid.compact_session":
      if (mode === "compact-refusal") { write({ type: "response", id: message.id, error: { code: -32602, message: "Nothing to compact" } }); return; }
      note({ type: "session_compacted", summaryId: "summary", removedCount: 4 });
      reply({ newSessionId: sessionId, removedCount: mode === "compact-zero" ? 0 : 4 });
      return;
    case "droid.list_models":
      reply({ models: [{ id: "gpt-6.1-sol", displayName: "GPT 6.1 Sol", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" }] });
      return;
    default:
      if (message.type === "request") { reply({}); }
  }
});
