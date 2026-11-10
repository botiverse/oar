import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";

/**
 * agy 1.5.5 ignores BROWSER and starts the platform launcher itself, found on
 * PATH: `xdg-open` (its binary names it and `rundll32`; macOS `open`). For
 * `openBrowser: false` the login child gets a PATH whose first directory holds
 * a launcher that does nothing (as Kimi's login does). The URL is still
 * relayed; nothing opens on this machine.
 */
export async function antigravityNoBrowserEnv(env: NodeJS.ProcessEnv): Promise<{ readonly env: NodeJS.ProcessEnv; dispose(): Promise<void> }> {
  if (!["linux", "darwin", "win32"].includes(process.platform)) { throw new Error("Antigravity browser suppression is unavailable on this platform"); }
  const directory = await mkdtemp(path.join(tmpdir(), "oar-agy-browser-"));
  const dispose = async (): Promise<void> => { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); };
  try {
    // On Windows a real executable: hostname changes nothing and opens no page.
    await (process.platform === "win32"
      ? copyFile(path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "hostname.exe"), path.join(directory, "rundll32.exe"))
      : writeFile(path.join(directory, process.platform === "darwin" ? "open" : "xdg-open"), "#!/bin/sh\nexit 0\n", { mode: 0o700, flag: "wx" }));
    const value = environmentValue(env, "PATH");
    return { env: sessionEnvironment({ PATH: directory + (value === undefined || value === "" ? "" : path.delimiter + value) }, env), dispose };
  } catch (error) { await dispose(); throw error; }
}
