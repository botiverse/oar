/* oxlint-disable typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-assignment, typescript/no-unsafe-argument, typescript/no-unsafe-return, eslint/no-await-in-loop -- Untyped raw ACP child-process fixture replaying recorded native wire in its recorded order. */
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

// argv: recorded evidence JSON (experiments/opencode-child-background), and a file receiving OAR's initialize params.
const [evidencePath, capturePath] = process.argv.slice(2);
const { wire } = JSON.parse(readFileSync(evidencePath, "utf8"));
let cursor = 0;

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

/** The recorded request answering OAR's method, at or after the cursor. */
function recordedRequest(method) {
  return wire.findIndex((frame, at) => at >= cursor && frame.direction === "toRuntime" && frame.message.method === method);
}

/** Answer OAR's request with the recorded answer, then replay the native frames that followed it, keeping recorded gaps (capped). */
async function answer(request) {
  const index = recordedRequest(request.method);
  if (index === -1) { send({ jsonrpc: "2.0", id: request.id, result: {} }); return; }
  const { id: recordedId } = wire[index].message;
  cursor = index + 1;
  for (; cursor < wire.length && wire[cursor].direction !== "toRuntime"; cursor += 1) {
    const { message } = wire[cursor];
    await delay(Math.min(Math.max(wire[cursor].atMs - wire[cursor - 1].atMs, 0), 50));
    send(message.id === recordedId && !("method" in message) ? { ...message, id: request.id } : message);
  }
}

const requests = [];
let draining = false;
async function drain() {
  if (draining) { return; }
  draining = true;
  while (requests.length > 0) { await answer(requests.shift()); }
  draining = false;
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (typeof message.method !== "string" || !("id" in message)) { return; }
  if (message.method === "initialize") { writeFileSync(capturePath, JSON.stringify(message.params)); }
  requests.push(message);
  void drain();
});
