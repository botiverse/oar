import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import type { Installation, InstallationSnapshot, InstallationSource } from "../../contracts/installation.js";
import { resolveExecutable, runExecutable } from "../../shared/executable/index.js";
import type { ExecutableRunner } from "../../shared/executable/index.js";

export interface CodexInstallationDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly exists?: (filePath: string) => boolean;
  readonly resolve?: (command: string) => string | null;
  readonly run?: ExecutableRunner;
  readonly now?: () => number;
}

interface Candidate {
  readonly command: string;
  readonly source: InstallationSource;
}

function candidates(dependencies: CodexInstallationDependencies): readonly Candidate[] {
  const env = dependencies.env ?? process.env;
  const exists = dependencies.exists ?? existsSync;
  const resolve = dependencies.resolve ?? resolveExecutable;
  const explicit = env.CODEX_BIN?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    const command = path.isAbsolute(explicit) ? explicit : resolve(explicit);
    return command !== null && exists(command) ? [{ command, source: "explicit" }] : [];
  }

  const found: Candidate[] = [];
  const onPath = resolve("codex");
  if (onPath !== null) found.push({ command: onPath, source: "path" });
  if ((dependencies.platform ?? process.platform) === "darwin") {
    const home = dependencies.homeDirectory ?? os.homedir();
    for (const command of [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      path.join(home, ".codex", "plugins", ".plugin-appserver", "codex"),
    ]) {
      if (exists(command) && !found.some((candidate) => candidate.command === command)) {
        found.push({ command, source: "bundled" });
      }
    }
  }
  return found;
}

function observedAt(dependencies: CodexInstallationDependencies): string {
  return new Date((dependencies.now ?? Date.now)()).toISOString();
}

export function createCodexInstallation(
  dependencies: CodexInstallationDependencies = {},
): Installation {
  return {
    async probe(): Promise<InstallationSnapshot> {
      const available = candidates(dependencies);
      if (available.length === 0) {
        return { runtime: "codex", state: "not_installed", observedAt: observedAt(dependencies) };
      }
      const run = dependencies.run ?? runExecutable;
      const runOptions = {
        timeoutMs: 5_000,
        ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
      };
      for (const candidate of available) {
        const appServer = await run(candidate.command, ["app-server", "--help"], runOptions);
        if (!appServer.ok) continue;
        const version = await run(candidate.command, ["--version"], runOptions);
        return {
          runtime: "codex",
          state: "available",
          observedAt: observedAt(dependencies),
          source: candidate.source,
          ...(version.ok && version.stdout.trim().length > 0
            ? { version: version.stdout.trim().split(/\r?\n/u)[0] }
            : {}),
        };
      }
      return {
        runtime: "codex",
        state: "incompatible",
        observedAt: observedAt(dependencies),
        ...(available[0] === undefined ? {} : { source: available[0].source }),
        diagnostic: { code: "app_server_unavailable" },
      };
    },
  };
}
