import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import type { Installation, InstallationSnapshot } from "../../contracts/installation.js";
import { resolveExecutable, runExecutable, type ExecutableRunner } from "../../shared/executable/index.js";

export interface CodexInstallationDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly exists?: (filePath: string) => boolean;
  readonly resolve?: (command: string) => string | null;
  readonly run?: ExecutableRunner;
}

function candidates(dependencies: CodexInstallationDependencies): readonly string[] {
  const env = dependencies.env ?? process.env;
  const exists = dependencies.exists ?? existsSync;
  const resolve = dependencies.resolve ?? resolveExecutable;
  const explicit = env.CODEX_BIN?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    const command = path.isAbsolute(explicit) ? explicit : resolve(explicit);
    return command !== null && exists(command) ? [command] : [];
  }

  const found: string[] = [];
  const onPath = resolve("codex");
  if (onPath !== null) {
    found.push(onPath);
  }
  if ((dependencies.platform ?? process.platform) === "darwin") {
    const home = dependencies.homeDirectory ?? os.homedir();
    for (const command of [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      path.join(home, ".codex", "plugins", ".plugin-appserver", "codex"),
    ]) {
      if (exists(command) && !found.includes(command)) {
        found.push(command);
      }
    }
  }
  return found;
}

export function createCodexInstallation(
  dependencies: CodexInstallationDependencies = {},
): Installation {
  return {
    async probe(): Promise<InstallationSnapshot> {
      const available = candidates(dependencies);
      if (available.length === 0) {
        return { kind: "not_found" };
      }

      const run = dependencies.run ?? runExecutable;
      const options = {
        timeoutMs: 5000,
        ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
      };
      for (const command of available) {
        const appServer = await run(command, ["app-server", "--help"], options);
        if (!appServer.ok && appServer.exitCode === null) {
          throw new Error("Failed to probe the Codex app-server surface");
        }
        if (!appServer.ok) {
          continue;
        }

        const version = await run(command, ["--version"], options);
        if (!version.ok && version.exitCode === null) {
          throw new Error("Failed to probe the Codex installation version");
        }
        const value = version.stdout.trim().split(/\r?\n/u)[0];
        return {
          kind: "available",
          ...(version.ok && value !== undefined && value.length > 0 ? { version: value } : {}),
        };
      }
      return { kind: "unsupported", reason: "app_server_unavailable" };
    },
  };
}
