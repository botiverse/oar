/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call -- Standalone native process fixture. */
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
  if (process.env.OAR_TREE_PIDS !== undefined) { writeFileSync(process.env.OAR_TREE_PIDS, JSON.stringify({ root: process.pid, tool: tool.pid })); }
  console.log(tool.pid);
});
process.stdin.resume();
process.stdin.on("end", () => { console.log("hook-complete"); process.exit(0); });
