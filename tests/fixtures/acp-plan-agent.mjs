/* oxlint-disable import/no-nodejs-modules, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-call -- Standalone native wire fixture. */
import { createInterface } from "node:readline";

/**
 * The standard ACP `plan` session update, which no captured vendor traffic in
 * this repository has shown yet (experiments/acp-plan-2026-11-24.json holds
 * the SDK 1.4.0 schema). The ACP client validates every `session/update`
 * against its closed union before any handler runs, so this fixture also
 * proves the shape is the standard one.
 */
const OPENING = {
  protocolVersion: 1,
  agentCapabilities: { sessionCapabilities: {} },
  authMethods: [{ id: "cached", name: "Cached login" }],
};
const SESSION = { sessionId: "plan-session", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } };

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function update(value) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "plan-session", update: value } });
}
// The whole checklist twice: started, then every step done.
const STARTED = [
  { content: "Read the wire shape", priority: "high", status: "in_progress" },
  { content: "Write the checklist spec", priority: "medium", status: "pending" },
];
const DONE = STARTED.map((entry) => ({ ...entry, status: "completed" }));
function answer(method) {
  if (method === "initialize") { return OPENING; }
  if (method === "session/new" || method === "session/resume") { return SESSION; }
  return {};
}
/** The agent's WHOLE checklist each time, then its own clear: `entries: []`. */
function promptReply(id) {
  update({ sessionUpdate: "plan", entries: STARTED });
  update({ sessionUpdate: "plan", entries: DONE });
  update({ sessionUpdate: "plan", entries: [] });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "plan-done" } });
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "session/prompt") {
    promptReply(message.id);
    return;
  }
  if (message.id === undefined) { return; }
  send({ jsonrpc: "2.0", id: message.id, result: answer(message.method) });
});
