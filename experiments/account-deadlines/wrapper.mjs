#!/usr/bin/env node
/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone wrapper for the native Linux deadline probe. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const { OAR_DEADLINE_NATIVE: command, OAR_DEADLINE_EVENTS: events, OAR_DEADLINE_METHOD: withheld } = process.env;
assert.ok(command !== undefined && events !== undefined && withheld !== undefined);
const record = (event, pids = []) => { appendFileSync(events, `${JSON.stringify({ event, at: Date.now(), pids })}\n`); };
record("wrapper", [process.pid]);
const child = spawn(command, process.argv.slice(2), { stdio: ["pipe", "pipe", "ignore"] });
assert.ok(child.pid);
record("launcher", [child.pid]);
child.stdout.pipe(process.stdout);
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === withheld) {
    const children = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim();
    // 0.131.0 has a Node launcher; 0.167.0 execve replaces it with the binary.
    const native = children === "" ? [child.pid] : children.split(/\s+/u).map(Number);
    record("withheld", native);
    for (const pid of native) { process.kill(pid, "SIGSTOP"); }
    return; // In particular, consume never reaches the app-server or a backend.
  }
  child.stdin.write(`${line}\n`);
});
process.on("SIGTERM", () => { record("sigterm"); child.kill("SIGTERM"); });
child.once("exit", () => { process.exit(0); });
