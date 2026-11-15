/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/strict-boolean-expressions -- Standalone JSON-RPC experiment over the existing fake agent. */
// A NEW synthetic sample, not the lost 2026-11-05 review trace.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [fixture, configId, log] = process.argv.slice(2);
if (!fixture || !configId || !log) { throw new Error("usage: fake-relay.mjs <fixture> <config-id> <wire.jsonl>"); }
const child = spawn(process.execPath, [fixture, "antigravity"], { stdio: ["pipe", "pipe", "inherit"] });
const record = row => { appendFileSync(log, `${JSON.stringify(row)}\n`); };
const send = message => { record({ kind: "delivered", message }); process.stdout.write(`${JSON.stringify(message)}\n`); };
createInterface({ input: process.stdin }).on("line", line => { record({ kind: "request", message: JSON.parse(line) }); child.stdin.write(`${line}\n`); });
createInterface({ input: child.stdout }).on("line", line => {
  const message = JSON.parse(line);
  if (message.params?.update?.sessionUpdate !== "config_option_update") { send(message); return; }
  const options = message.params.update.configOptions;
  const selected = options.find(option => option.id === configId);
  if (selected?.currentValue !== (configId === "model" ? "requested-y" : "high")) { send(message); return; }
  record({ kind: "scheduled-requested-update", delayMs: 50, message });
  send({ ...message, params: { ...message.params, update: { ...message.params.update, configOptions:
    // oxlint-disable-next-line oxc/no-map-spread -- Keep the queued correct notification unchanged.
    options.map(option => option.id === configId ? { ...option, currentValue: configId === "model" ? "fixture-model-x" : "medium" } : option),
  } } });
  setTimeout(() => { send(message); }, 50);
});
const stop = () => { child.kill(); };
process.on("SIGTERM", stop);
process.stdin.on("end", stop);
child.on("error", error => { throw error; });
child.on("exit", code => { process.exit(code ?? 1); });
