#!/usr/bin/env node
/* oxlint-disable -- A raw JSON-RPC wire tap for this manual Linux experiment; native envelopes intentionally remain opaque and are logged only in a private output directory. */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
const log = (x) =>
  appendFileSync(
    process.env.OAR_PROBE_WIRE_LOG,
    JSON.stringify({ at: new Date().toISOString(), ...x }) + "\n",
  );
const summarize = (x) =>
  JSON.parse(
    JSON.stringify(x, (key, value) =>
      typeof value === "string" && value.length > 10000
        ? { characters: value.length, prefix: value.slice(0, 40) }
        : value,
    ),
  );
const child = spawn(
  process.env.OAR_PROBE_NATIVE_COMMAND,
  process.argv.slice(2),
  { env: process.env, stdio: ["pipe", "pipe", "pipe"] },
);
log({ event: "spawn", wrapperPid: process.pid, nativePid: child.pid });
createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (
    req.method === "turn/start" &&
    existsSync(process.env.OAR_PROBE_FAULT_FILE)
  ) {
    req.params.threadId = "00000000-0000-4000-8000-000000000001";
    log({ event: "fault", fault: "replace-thread-id", method: req.method });
  }
  log({ event: "request", message: summarize(req) });
  child.stdin.write(JSON.stringify(req) + "\n");
});
createInterface({ input: child.stdout }).on("line", (line) => {
  try {
    log({ event: "response", message: summarize(JSON.parse(line)) });
  } catch {
    log({ event: "non_json", line });
  }
  process.stdout.write(line + "\n");
});
createInterface({ input: child.stderr }).on("line", (line) =>
  log({ event: "stderr", line }),
);
child.on("error", (e) => {
  log({ event: "spawn_error", message: e.message });
  process.exit(1);
});
child.on("exit", (code, signal) => {
  log({ event: "exit", code, signal });
  process.exit(code ?? 1);
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
