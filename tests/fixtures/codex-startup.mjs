/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped JSON-RPC process fixture. */
import { existsSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

// Inspired by deepseek-harness's subagent-oar startup-cleanup fixture: a
// SIGTERM barrier distinguishes requesting termination from observing exit.
const { OAR_FIXTURE_PID: pid, OAR_FIXTURE_RELEASE: release, OAR_FIXTURE_STOPPING: stopping, OAR_FIXTURE_FAILURE: failure } = process.env;
if (release !== undefined && stopping !== undefined) {
  process.on("SIGTERM", () => {
    const leave = () => { if (existsSync(release) === true) { process.exit(0); } };
    watch(dirname(release), leave);
    writeFileSync(stopping, "stopping");
    leave();
  });
}
writeFileSync(pid, String(process.pid));
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (typeof request.id !== "number") { return; }
  const opened = request.method === "thread/start" || request.method === "thread/resume";
  const result = opened && failure !== "missing-thread-id"
    ? { thread: { id: "fixture-thread", name: null }, model: "fixture-model", reasoningEffort: "low" }
    : {};
  const reply = request.method === failure
    ? { error: { code: -32_600, message: `fixture refused ${request.method}` } }
    : { result };
  process.stdout.write(`${JSON.stringify({ id: request.id, ...reply })}\n`);
});
// Closing stdin alone must not release the SIGTERM barrier.
setInterval(() => {}, 1000);
