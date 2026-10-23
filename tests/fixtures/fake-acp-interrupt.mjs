/* oxlint-disable eslint/max-statements, typescript/strict-boolean-expressions, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return -- Raw JSON-RPC fixture in a separate Node process. */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [controlFile, mode] = process.argv.slice(2);
let pending = undefined;
let lastCommand = "";
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const result = (id, value = {}) => send({ jsonrpc: "2.0", id, result: value });
const update = (value) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "interrupt-fixture", update: value } });
const finish = (stopReason) => {
  if (pending === undefined) { return; }
  result(pending, { stopReason });
  pending = undefined;
};
setInterval(() => {
  let command = "";
  try { command = readFileSync(controlFile, "utf8"); } catch { return; }
  if (lastCommand === command) { return; }
  lastCommand = command;
  if (command === "end") { finish("end_turn"); }
  if (command.startsWith("tool:")) { update({ sessionUpdate: "tool_call_update", toolCallId: command.slice(5), status: "completed" }); }
  if (command === "exit") { process.exit(17); }
}, 5).unref();

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize": result(message.id, { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, authMethods: [] }); break;
    case "session/new": result(message.id, { sessionId: "interrupt-fixture" }); break;
    case "session/prompt": {
      const text = message.params.prompt.find((part) => part.type === "text")?.text;
      if (text === "work") {
        pending = message.id;
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
        if (mode === "child-only") {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "child-fixture", update: { sessionUpdate: "tool_call", toolCallId: "child", title: "child", kind: "execute", status: "in_progress" } } });
        } else if (mode !== "no-tools") {
          for (const id of ["one", "two"]) { update({ sessionUpdate: "tool_call", toolCallId: id, title: id, kind: "execute", status: "in_progress" }); }
        }
      } else {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(message.params.prompt) } });
        result(message.id, { stopReason: "end_turn" });
      }
      break;
    }
    case "session/cancel": if (mode !== "ignore-cancel") { finish("cancelled"); } break;
    default: if (message.id !== undefined) { result(message.id); }
  }
});
