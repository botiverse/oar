/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped child-process fixture. */
import { captureProcess } from "./process-tree.ts";
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

// The grandchild can close or inherit the probe's output pipes and ignores SIGTERM.
// Report only after that handler is installed, then optionally exit the
// group leader without waiting for the grandchild or closing its pipes.
const grandchild = spawn(process.execPath, ["-e", `
process.on("SIGTERM", () => {});
process.send("ready");
setTimeout(() => { process.exit(0); }, 60_000);
`], { stdio: ["ignore", process.env.OAR_FIXTURE_CLOSED_PIPES === "1" ? "ignore" : "inherit", process.env.OAR_FIXTURE_CLOSED_PIPES === "1" ? "ignore" : "inherit", "ipc"] });
function publishTree() {
  const file = process.env.OAR_FIXTURE_PIDS;
  try {
    if (file === undefined) { throw new Error("missing pid file"); }
    writeFileSync(`${file}.tmp`, JSON.stringify({ agent: captureProcess(process.pid), grandchild: captureProcess(grandchild.pid) }));
    renameSync(`${file}.tmp`, file);
  } catch (error) {
    grandchild.kill("SIGKILL");
    throw error;
  }
}
grandchild.once("message", () => {
  publishTree();
  const flood = process.env.OAR_FIXTURE_FLOOD;
  if (flood === "stdout" || flood === "stderr") {
    process[flood].write("x".repeat(2 * 1024 * 1024 + 1));
  }
  if (process.env.OAR_FIXTURE_EARLY_EXIT === "1") { process.exit(0); }
});
