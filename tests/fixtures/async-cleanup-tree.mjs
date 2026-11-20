/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone native process fixture. */
import { captureProcess } from "./process-tree.ts";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const tool = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000); process.send('ready', () => process.disconnect());"], {
  detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
});
let ready = false;
tool.once("message", (value) => { ready = value === "ready"; });
tool.once("disconnect", () => {
  if (!ready) { throw new Error("tool disconnected before readiness"); }
  tool.unref();
  const report = JSON.stringify({ root: captureProcess(process.pid), tool: captureProcess(tool.pid) });
  if (process.env.OAR_TREE_PIDS !== undefined) { writeFileSync(process.env.OAR_TREE_PIDS, report); }
  console.log(report);
});
process.stdin.resume();
if (process.env.OAR_TREE_IGNORE_EOF === "1") { setInterval(() => {}, 1000); }
process.stdin.on("end", () => { if (process.env.OAR_TREE_IGNORE_EOF !== "1") { console.log("hook-complete"); process.exit(0); } });
