/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped child-process fixture. */
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

/*
 * Opt-in process-tree behavior for a fake agent process, switched by env and
 * run on import, so any fixture can carry it (`import "./agent-tree.mjs"`, or
 * `node --import <this file> <fixture>`):
 * - OAR_FIXTURE_PIDS=<file>: start a grandchild (a tool the agent runs, here
 *   a Node process sleeping for 60 s) and write {"agent", "grandchild"} to <file>.
 * - OAR_FIXTURE_IGNORE_SIGTERM=1: ignore SIGTERM and stay alive past stdin
 *   EOF, so only SIGKILL ends the agent.
 * Everything it starts ends on its own within a minute, so a failed test
 * leaks nothing for long.
 */
if (process.env.OAR_FIXTURE_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
  setTimeout(() => {
    process.exit(0);
  }, 60_000);
}
const pidFile = process.env.OAR_FIXTURE_PIDS;
if (pidFile !== undefined) {
  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  grandchild.once("spawn", () => {
    writeFileSync(`${pidFile}.tmp`, JSON.stringify({ agent: process.pid, grandchild: grandchild.pid }));
    renameSync(`${pidFile}.tmp`, pidFile);
  });
}
