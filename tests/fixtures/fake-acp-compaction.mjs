/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-return, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-call -- Standalone untyped native-process fixture. */
/* oxlint-disable eslint/max-statements, eslint/max-params -- One ordered wire script, including deliberately foreign identities. */
import { createInterface } from "node:readline";

const [backend, mode] = process.argv.slice(2);
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
const answer = (id, result) => send({ id, result });
const update = (status, messageId = "compact-one", reason = "manual", sessionId = "root") => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "session_info_update", _meta: { "opencode/compaction": { status, messageId, reason, ...(status === "failed" ? { error: { type: mode === "cancel" ? "aborted" : "provider.invalid-request" } } : {}) } } } } });
let pending = null;
function complete() {
  const id = pending;
  pending = null;
  if (backend === "grok") {
    if (mode === "failed" || mode === "cancel") { send({ id, error: { code: -32_603, message: "Internal error", data: { kind: mode === "cancel" ? "compact_cancelled" : "compact_failed" } } }); }
    else { answer(id, {}); }
  } else {
    if (mode !== "missing") { update(mode === "failed" || mode === "cancel" ? "failed" : "completed"); }
    answer(id, { stopReason: mode === "cancel" ? "cancelled" : "end_turn", usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } });
  }
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") { answer(id, { protocolVersion: 1, agentCapabilities: { promptCapabilities: {} }, authMethods: [] }); }
  else if (method === "session/new") { answer(id, { sessionId: "root" }); }
  else if (method === "session/cancel") { if (pending !== null) { complete(); } }
  else if (method === "_x.ai/compact_conversation" || (method === "session/prompt" && params.prompt?.[0]?.text === "/compact")) {
    pending = id;
    if (mode === "disconnect") { process.exit(1); }
    if (mode === "malformed") { pending = null; answer(id, null); return; }
    if (mode === "rpc-error" || mode === "no-method" || mode === "no-session" || mode === "bad-params") {
      pending = null;
      send({ id, error: { code: mode === "no-method" ? -32_601 : -32_602, message: mode, data: { kind: mode } } }); return;
    }
    if (backend === "opencode") {
      update("started", "foreign", "manual", "child"); update("completed", "foreign", "manual", "child");
      update("started", "automatic", "overflow"); update("completed", "automatic", "overflow");
      update("completed", "old");
      if (mode !== "missing") { update("started"); update("completed", "wrong-id"); update("completed", "old"); update("completed", null); }
    } else { send({ method: "_x.ai/session_notification", params: { sessionId: "root", update: { sessionUpdate: "auto_compact_completed" } } }); }
    if (mode === "reply-held") { update("completed"); }
    if (mode !== "hold" && mode !== "cancel" && mode !== "reply-held") { setTimeout(complete, 25); }
  } else if (method === "session/prompt") {
    send({ method: "session/update", params: { sessionId: "root", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: params.prompt?.[0]?.text } } } });
    answer(id, { stopReason: "end_turn" });
  } else if (id !== undefined) { answer(id, {}); }
});
