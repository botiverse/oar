/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call -- Standalone native ACP fixture. */
import { spawn } from "node:child_process";

const tool = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000); process.send('ready', () => process.disconnect());"], {
  detached: true, windowsHide: true, stdio: ["ignore", process.env.OAR_ACP_HOLD_STDOUT === "1" ? 1 : "ignore", "ignore", "ipc"],
});
let ready = false;
tool.once("message", (value) => { ready = value === "ready"; });
tool.once("disconnect", () => {
  if (!ready) { throw new Error("tool disconnected before readiness"); }
  tool.unref();
  console.log(JSON.stringify({ jsonrpc: "2.0", method: "fixture/ready", params: { root: process.pid, tool: tool.pid } }));
  setInterval(() => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "fixture/pulse", params: {} })}\n`);
  }, 1);
});
process.stdin.resume();
const stop = () => { process.stderr.write("native-shutdown-hook\n"); process.exit(0); };
process.stdin.on("end", stop);
process.on("SIGTERM", stop);
