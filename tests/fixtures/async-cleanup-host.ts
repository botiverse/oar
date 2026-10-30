import { fileURLToPath } from "node:url";

// Executed in a separate host: native patches cannot affect the Vitest process.
const asyncCleanupHost = String.raw`
import fs from "node:fs";
import fsAsync from "node:fs/promises";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { spawnLineProcess } from ${JSON.stringify(new URL("../../packages/oar/src/shared/executable/process.ts", import.meta.url).href)};

process.on("unhandledRejection", () => { fs.writeFileSync(process.env.OAR_UNHANDLED, "rejected"); process.exit(98); });
const phase = process.env.OAR_CLEANUP_PHASE;
const root = spawnLineProcess(process.execPath, [${JSON.stringify(fileURLToPath(new URL("async-cleanup-tree.mjs", import.meta.url)))}], { killTree: true, shutdown: "stdin" });
await new Promise((resolve) => { root.onLine((line) => { if (/^\d+$/u.test(line)) { resolve(); } }); });
let reads = 0;
const shouldPause = () => ++reads === (phase === "capture" ? 1 : 2);
const interrupted = () => {
  fs.writeFileSync(process.env.OAR_PAUSED, phase);
  setTimeout(() => {
    if (phase === "finish" && root.diagnostics().exitCode !== 0) { process.exit(97); }
    process.exit(23);
  }, 100);
};
const readdir = fsAsync.readdir;
fsAsync.readdir = (directory, ...args) => {
  if (directory === "/proc" && shouldPause()) { interrupted(); return new Promise(() => {}); }
  return readdir(directory, ...args);
};
const spawn = cp.spawn;
cp.spawn = (command, ...args) => {
  if ((command === "ps" || command === "powershell.exe") && shouldPause()) {
    const query = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], args[1]);
    fs.writeFileSync(process.env.OAR_QUERY_PID, String(query.pid));
    interrupted(); return query;
  }
  return spawn(command, ...args);
};
syncBuiltinESMExports();
root.kill();
await root.exited;
throw new Error("host handoff never interrupted cleanup");
`;

export default asyncCleanupHost;
