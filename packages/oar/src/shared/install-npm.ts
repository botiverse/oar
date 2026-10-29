import path from "node:path";
import type { InstallPlanner, InstallStep } from "../contracts/install.js";
import { runExecutable } from "./executable/index.js";
import { defaultInstallHost, type InstallHost } from "./install.js";
import { updaterEnv } from "./update.js";
import { privateTempDir } from "./private-temp.js";

/** A vendor's documented npm package, installed globally without selecting a version. */
export interface NpmInstallMethod {
  readonly packageName: string;
  readonly source: string;
}

/** Read npm's own configuration, including environment and user/global npmrc, without installing or retaining cache files. */
export async function npmGlobalPrefix(npm: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  // npm eagerly creates cache files even for prefix. Keep them in OAR's
  // private system-temporary directory, never in HOME or Node's installation.
  const cache = await privateTempDir("oar-npm-prefix-");
  try {
    const result = await runExecutable(npm, ["prefix", "-g", "--cache", cache.path, "--loglevel=error", "--logs-max=0", "--timing=false", "--update-notifier=false"], {
      env: updaterEnv(env), timeoutMs: 15_000,
    });
    const prefix = result.stdout.replace(/\r?\n$/u, "");
    if (!result.ok || !path.isAbsolute(prefix) || /[\r\n\0]/u.test(prefix)) {
      throw new Error("Could not read npm's global installation directory");
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
    const prefix = await npmGlobalPrefix(npm);
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
