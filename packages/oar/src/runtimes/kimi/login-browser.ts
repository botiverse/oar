import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";

export interface KimiLoginBrowser {
  readonly env: NodeJS.ProcessEnv;
  dispose(): Promise<void>;
}

/** Match Kimi's lexical workspace exclusion before placing a PATH helper. */
export function kimiCanResolveBrowser(helper: string, cwd: string, platform: NodeJS.Platform): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const directory = paths.resolve(cwd);
  if (directory === paths.parse(directory).root) { return true; }
  const relative = platform === "win32"
    ? paths.relative(directory.toLowerCase(), paths.resolve(helper).toLowerCase())
    : paths.relative(directory, paths.resolve(helper));
  return relative === "" || relative.startsWith("..") || paths.isAbsolute(relative);
}

/** Kimi 2.3.3 ignores BROWSER, but resolves these names itself and execFiles the absolute path. */
export async function kimiLoginBrowser(env: NodeJS.ProcessEnv): Promise<KimiLoginBrowser> {
  if (!["linux", "darwin", "win32"].includes(process.platform)) { throw new Error("Kimi browser suppression is unavailable on this platform"); }
  const directory = await mkdtemp(path.join(tmpdir(), "oar-kimi-browser-"));
  const dispose = async (): Promise<void> => { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); };
  try {
    const helper = path.join(directory, process.platform === "win32" ? "powershell.exe" : (process.platform === "darwin" ? "open" : "xdg-open"));
    if (!kimiCanResolveBrowser(helper, process.cwd(), process.platform)) { throw new Error("Kimi excludes the temporary browser helper inside the current directory"); }
    // A real executable is required on Windows; hostname cannot open a URL
    // with Kimi's PowerShell flags. A renamed .cmd cannot be execFiled.
    await (process.platform === "win32"
      ? copyFile(path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "hostname.exe"), helper)
      : writeFile(helper, "#!/bin/sh\nexit 0\n", { mode: 0o700, flag: "wx" }));
    const value = environmentValue(env, "PATH");
    return { env: sessionEnvironment({ PATH: directory + (value === undefined || value === "" ? "" : path.delimiter + value) }, env), dispose };
  } catch (error) { await dispose(); throw error; }
}
