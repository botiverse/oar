// oxlint-disable -- A stand-in executable, deliberately untyped like the protocol it fakes.
// A stand-in `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`
// (droid 1.12.1, protocol 1.340.0): opens a session and answers each user message with "ok".
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const envelope = { jsonrpc: "2.0", factoryApiVersion: "1.0.0", factoryProtocolVersion: "1.340.0" };
const write = (message) => { process.stdout.write(`${JSON.stringify({ ...envelope, ...message })}\n`); };
const note = (notification) => { write({ type: "notification", method: "droid.session_notification", params: { sessionId, notification } }); };
let sessionId = randomUUID();
const settings = { modelId: "gpt-6.1-sol", reasoningEffort: "high", autonomyLevel: "medium" };
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const reply = (result) => { write({ type: "response", id: message.id, result }); };
  if (message.method === "droid.initialize_session" || message.method === "droid.load_session") {
    sessionId = message.params.sessionId ?? sessionId;
    Object.assign(settings, message.params.modelId ? { modelId: message.params.modelId } : {}, message.params.reasoningEffort ? { reasoningEffort: message.params.reasoningEffort } : {});
    note({ type: "settings_updated", settings });
    reply({ sessionId, session: { messages: [] }, settings, ...(message.params.cwd ? {} : { cwd: process.cwd() }) });
  } else if (message.method === "droid.add_user_message") {
    reply({});
    note({ type: "create_message", requestId: message.id, message: { id: message.params.messageId, role: "user", content: [{ type: "text", text: message.params.text }] } });
    note({ type: "assistant_text_delta", messageId: "m1", blockIndex: 0, textDelta: "ok" });
    note({ type: "agent_turn_completed", reason: "completed", turnId: message.params.messageId, tokenUsage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 } });
  } else if (message.method === "droid.get_context_stats") {
    reply({ used: 10, remaining: 90, limit: 100, accuracy: "estimated", updatedAt: new Date().toISOString() });
  } else if (message.method === "droid.list_models") {
    reply({ models: [{ id: "gpt-6.1-sol", displayName: "GPT 6.1 Sol", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" }] });
  } else if (message.type === "request") {
    reply({});
  }
});
