/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return -- Standalone native protocol fixture. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const { 2: protocol } = process.argv;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const middleFile = fileURLToPath(new URL("shutdown-orphan-tree.mjs", import.meta.url));
let current = null;
const roots = [];
const text = value => {
  if (protocol === "acp") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "cancel-root", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(value) } } } });
  } else {
    send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: JSON.stringify(value) } } });
  }
};
const finish = (/** @type {boolean} */ cancelled) => {
  if (current === null) { return; }
  if (protocol === "acp") { send({ jsonrpc: "2.0", id: current.id, result: { stopReason: cancelled ? "cancelled" : "end_turn" } }); }
  else { send({ type: "result", subtype: "success", is_error: false }); }
};
async function prompt(id) {
  const middle = spawn(process.execPath, [middleFile, "middle"], { detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  roots.push(middle);
  const [ready] = await once(middle, "message");
  current = { id, middle, ready };
  text(ready);
  if (roots.length === 1 && typeof process.env.OAR_CANCEL_NATURAL_FILE === "string") {
    const signalFile = process.env.OAR_CANCEL_NATURAL_FILE;
    const timer = setInterval(() => { if (existsSync(String(signalFile)) === true) { clearInterval(timer); finish(false); } }, 10);
  }
}
// oxlint-disable-next-line eslint/max-statements -- Native cancellation deliberately separates parent exit, acknowledgment and turn completion.
async function cancel(request) {
  if (current === null) { return; }
  const { middle } = current;
  if (middle.exitCode === null) { const exited = once(middle, "exit"); middle.send("exit"); await exited; }
  text({ cancelled: true });
  if (process.env.OAR_CANCEL_EXIT === "1") { process.exit(0); }
  if (protocol !== "acp") { send({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: {} } }); }
  if (process.env.OAR_CANCEL_HANG !== "1") { finish(true); }
}
const input = readline.createInterface({ input: process.stdin });
// oxlint-disable-next-line eslint/max-statements -- A minimal dual-protocol peer exposes the same native orphan transition.
input.on("line", line => { void (async () => {
  try {
  const message = JSON.parse(line);
  const reply = result => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") { reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } }); }
  else if (message.method === "session/new") { reply({ sessionId: "cancel-root" }); }
  else if (message.method === "session/load" || message.method === "session/resume") { reply({}); }
  else if (message.method === "session/prompt" || message.type === "user") { await prompt(message.id); }
  else if (message.method === "session/cancel" || message.request?.subtype === "interrupt") { await cancel(message); }
  } catch (error) { console.error(error); process.exit(2); }
})(); });
input.on("close", () => { process.exit(0); });
