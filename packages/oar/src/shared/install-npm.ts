import path from "node:path";
import type { InstallPlanner, InstallStep, InstallUnsupported } from "../contracts/install.js";
import { runExecutable } from "./executable/index.js";
import { defaultInstallHost, type InstallHost } from "./install.js";
import { updaterEnv } from "./update.js";
import { privateTempDir } from "./private-temp.js";

const PREFIX_TIMEOUT_MS = 15_000;

/** A vendor's documented npm package, installed globally without selecting a version. */
export interface NpmInstallMethod {
  readonly packageName: string;
  readonly source: string;
}

/** Only controlled categories reach a plan; native output and error messages stay private. */
class NpmPrefixError extends Error {
  constructor(category: string) {
    super(`Could not determine npm's global installation directory: ${category}.`);
    this.name = "NpmPrefixError";
  }
}

/** Read npm's own configuration, including environment and user/global npmrc, without installing or retaining cache files. */
export async function npmGlobalPrefix(npm: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  // npm eagerly creates cache files even for prefix. Keep them in OAR's
  // private system-temporary directory, never in HOME or Node's installation.
  const cache = await privateTempDir("oar-npm-prefix-");
  try {
    const result = await runExecutable(npm, ["prefix", "-g", "--cache", cache.path, "--loglevel=error", "--logs-max=0", "--timing=false", "--update-notifier=false"], {
      env: updaterEnv(env), timeoutMs: PREFIX_TIMEOUT_MS,
    });
    if (!result.ok) {
      if (result.diagnostics?.timeoutMs !== undefined) {
        throw new NpmPrefixError(`query timed out after ${String(PREFIX_TIMEOUT_MS)} ms`);
      }
      if (result.exitCode !== null) {
        throw new NpmPrefixError(`query exited with code ${String(result.exitCode)}`);
      }
      throw new NpmPrefixError("query could not start or complete");
    }
    const prefix = result.stdout.replace(/\r?\n$/u, "");
    if (!path.isAbsolute(prefix)) {
      throw new NpmPrefixError("query output is not an absolute path");
    }
    if (/[\r\n\0]/u.test(prefix)) {
      throw new NpmPrefixError("query output is not a single path");
    }
    return prefix;
  } finally { cache.remove(); }
}

/** npm puts global launchers directly in the prefix on Windows, and in its bin directory on POSIX. */
export function npmGlobalBin(prefix: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? prefix : path.join(prefix, "bin");
}

/** A plan that only writes a disposable private cache: inspect npm's global prefix and write access, then describe the documented installation. */
export function npmInstallPlan(method: NpmInstallMethod, host: InstallHost = defaultInstallHost): InstallPlanner {
  return async (options = {}) => {
    if (options.line !== undefined) {
      return { kind: "unsupported", reason: "unknown_line", detail: `this runtime ships one release line; leave line ${JSON.stringify(options.line)} out` };
    }
    if (!["linux", "darwin", "win32"].includes(host.platform)) {
      return { kind: "unsupported", reason: "platform", detail: `this npm installer is supported on Linux, macOS and Windows, not ${host.platform}` };
    }
    const steps: readonly InstallStep[] = [{ command: ["npm", "install", "-g", method.packageName], display: `npm install -g ${method.packageName}` }];
    const npm = host.locate("npm");
    if (npm === null) {
      return { kind: "unsupported", reason: "missing_tool", detail: "npm", steps, source: method.source };
    }
    const prefix = await npmGlobalPrefix(npm).catch((error: unknown): InstallUnsupported => ({
      kind: "unsupported", reason: "location_unknown",
      detail: error instanceof NpmPrefixError ? error.message : new NpmPrefixError("local query failed").message,
      steps, source: method.source,
    }));
    if (typeof prefix !== "string") { return prefix; }
    const library = host.platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
    for (const directory of [prefix, npmGlobalBin(prefix, host.platform), path.join(library, method.packageName)]) {
      const blocked = host.unwritable(directory);
      if (blocked !== null) {
        return { kind: "unsupported", reason: "requires_privileges", detail: `npm writes ${directory}, and ${blocked} is not writable by this user`, steps, source: method.source };
      }
    }
    return { kind: "plan", steps, source: method.source, network: true, privileges: false };
  };
}
