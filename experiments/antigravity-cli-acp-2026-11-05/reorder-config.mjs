/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/strict-boolean-expressions -- Standalone native JSON-RPC relay preserves raw lines without requiring a TypeScript loader. */
// Delivery-only control: hold each session's first native config update until
// its second update arrives. All native bytes and requests remain unchanged.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [binary, ...args] = process.argv.slice(2);
if (!binary) { throw new Error("usage: reorder-config.mjs <native binary> [args]"); }
const child = spawn(binary, args, { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(child.stdin);
const held = new Map();
const completed = new Set();
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  const message = JSON.parse(line);
  const id = message.params?.sessionId;
  const isConfig = message.method === "session/update" && message.params?.update?.sessionUpdate === "config_option_update";
  if (isConfig && !completed.has(id)) {
    if (!held.has(id)) { held.set(id, line); return; }
    process.stdout.write(`${line}\n${held.get(id)}\n`);
    held.delete(id); completed.add(id); return;
  }
  process.stdout.write(`${line}\n`);
});
child.on("error", error => { throw error; });
child.on("exit", code => { process.exitCode = code ?? 1; process.stdin.destroy(); });
