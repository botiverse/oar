/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/strict-boolean-expressions -- A raw native relay preserves JSON-RPC bytes and only delays an invalid steer request. */
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [binary, ...args] = process.argv.slice(2);
if (!binary) { throw new Error("Missing native binary"); }
const child = spawn(binary, args, { stdio: ["pipe", "pipe", "inherit"] });
writeFileSync(process.env.OAR_AGY_PROBE_PID_FILE, String(child.pid));
let original = null;
let held = null;
const record = (direction, message) => { appendFileSync(process.env.OAR_AGY_PROBE_TRACE, `${JSON.stringify({ direction, message })}\n`); };
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "session/prompt") {
    if (original === null) { original = message.id; }
    else if (process.env.OAR_AGY_PROBE_DELAY_STEER === "1") { held = line; return; }
  }
  record("out", message); child.stdin.write(`${line}\n`);
});
createInterface({ input: child.stdout }).on("line", line => {
  const message = JSON.parse(line);
  record("in", message); process.stdout.write(`${line}\n`);
  if (message.id === original && ("result" in message || "error" in message) && held !== null) {
    record("out", JSON.parse(held)); child.stdin.write(`${held}\n`); held = null;
  }
});
child.on("error", error => { throw error; });
child.on("exit", code => { process.exitCode = code ?? 1; process.stdin.destroy(); });
