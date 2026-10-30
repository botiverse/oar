/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped malformed-protocol fixture. */
import { createInterface } from "node:readline";

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function update() {
  return { jsonrpc: "2.0", method: "session/update", params: { sessionId: "protocol-close", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still-alive" } } } };
}
function opening(method) {
  if (method === "initialize") { return { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "cached", name: "Cached" }] }; }
  if (method === "session/new") { return { sessionId: "protocol-close" }; }
  return {};
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "session/prompt") {
    send([update()]);
    setInterval(() => { send(update()); }, 1);
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: opening(message.method) });
});
