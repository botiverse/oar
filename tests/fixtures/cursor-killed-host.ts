/* oxlint-disable import/prefer-default-export -- fixtures export names, like the package. */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FAKE_SDK_MODULE } from "./cursor-subprocess.js";

const source = path.join(import.meta.dirname, "../../packages/oar/src");

/**
 * A host that opens a session, has its run start a tool (`how`) that writes
 * the pids to `file`, and SIGKILLs itself. With `clean`, the session passes
 * PATH and HOME, as a host using `envBase: "clean"` does.
 */
export function killedHost(dir: string, file: string, run: { readonly how: string; readonly envBase?: "inherit" | "clean" }): SpawnSyncReturns<string> {
  const { how, envBase = "inherit" } = run;
  const base = envBase === "clean" ? { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } : {};
  const env = { ...base, OAR_FAKE_CURSOR_CLOSED: path.join(dir, "closed") };
  const script = `import { createCursorRuntime } from ${JSON.stringify(pathToFileURL(path.join(source, "index.ts")).href)};
import { awaitTurnEnd } from ${JSON.stringify(pathToFileURL(path.join(source, "observe/turns.ts")).href)};
const runtime = createCursorRuntime({ execution: "subprocess", sdkModule: ${JSON.stringify(FAKE_SDK_MODULE)}, envBase: ${JSON.stringify(envBase)} });
const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: ${JSON.stringify(dir)}, env: ${JSON.stringify(env)} });
const prompt = await session.prompt(${JSON.stringify(`${how}:${file}`)});
await awaitTurnEnd(session, prompt.seq);
process.kill(process.pid, "SIGKILL");`;
  // A short grace, so the child's own waits end well within the test.
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000, env: { ...process.env, OAR_KILL_GRACE_MS: "2000" } });
}
