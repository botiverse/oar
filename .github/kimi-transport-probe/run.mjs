import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [kind, prefix, output] = process.argv.slice(2);
const root = await mkdtemp(path.join(tmpdir(), "kimi-transport-"));
const script = fileURLToPath(new URL("./probe.mjs", import.meta.url));
const windows = process.platform === "win32";
const probe = spawn(process.execPath, [script, kind, prefix, output, root], {
  stdio: "inherit",
  detached: !windows,
});
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  if (windows) {
    spawn("taskkill.exe", ["/pid", String(probe.pid), "/t", "/f"], {
      stdio: "inherit",
    });
  } else {
    process.kill(-probe.pid, "SIGKILL");
  }
}, 90000);
try {
  const [exitCode, signal] = await once(probe, "exit");
  const result = JSON.parse(await readFile(output, "utf8"));
  result.hostExit = { exitCode, signal, timedOut };
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  result.homeRemovedAfterExit = true;
  await writeFile(output, JSON.stringify(result, null, 2));
  process.exitCode = exitCode ?? 1;
} finally {
  clearTimeout(timer);
}
