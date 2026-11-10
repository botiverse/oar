import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";

/**
 * agy 1.5.5 ignores BROWSER and starts the platform launcher itself. On Linux
 * it finds `xdg-open` on PATH (live control), so for `openBrowser: false` the
 * login child gets a PATH whose first directory holds a launcher that does
 * nothing (as Kimi's login does); macOS `open` is treated alike. On Windows it
 * runs `%SYSTEMROOT%\System32\rundll32.exe` by absolute path (Otter, static
 * reading of the official binary), which no PATH entry can replace, and
 * changing SYSTEMROOT would change far more than the browser: refused.
 */
export async function antigravityNoBrowserEnv(env: NodeJS.ProcessEnv): Promise<{ readonly env: NodeJS.ProcessEnv; dispose(): Promise<void> }> {
  if (!["linux", "darwin"].includes(process.platform)) { throw new Error("Antigravity browser suppression is unavailable on this platform"); }
  const directory = await mkdtemp(path.join(tmpdir(), "oar-agy-browser-"));
  const dispose = async (): Promise<void> => { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); };
  try {
    await writeFile(path.join(directory, process.platform === "darwin" ? "open" : "xdg-open"), "#!/bin/sh\nexit 0\n", { mode: 0o700, flag: "wx" });
    const value = environmentValue(env, "PATH");
    return { env: sessionEnvironment({ PATH: directory + (value === undefined || value === "" ? "" : path.delimiter + value) }, env), dispose };
  } catch (error) { await dispose(); throw error; }
}
