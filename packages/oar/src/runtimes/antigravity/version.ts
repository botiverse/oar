import type { ExecutableInstallation, VersionUnsupportedInstallation } from "../../contracts/installation.js";
import { runExecutable } from "../../shared/executable/index.js";
import { assertRan } from "../../shared/executable/diagnostics.js";
import { remainingMs } from "../../shared/deadline.js";
import { versionAtLeast } from "../../shared/update.js";

/** The first stable standalone CLI with the native ACP interface OAR drives. */
export const ANTIGRAVITY_MINIMUM_VERSION = "1.5.0";

/** The standalone CLI prints a bare release, unlike the retired ACP server's build stamp. */
export function readAntigravityVersion(stdout: string): string | undefined {
  return /^(\d+\.\d+\.\d+(?:-[A-Za-z\d.-]+)?)$/u.exec(stdout.trim())?.[1];
}

type VersionRefusal = Omit<VersionUnsupportedInstallation, "via" | "command">;

export function antigravityVersionRefusal(version: string | undefined): VersionRefusal | null {
  if (version !== undefined && /^\d+\.\d+\.\d+$/u.test(version) && versionAtLeast(version, ANTIGRAVITY_MINIMUM_VERSION)) { return null; }
  return {
    kind: "unsupported" as const, code: "version_unsupported" as const,
    reason: `Antigravity requires a stable agy CLI ${ANTIGRAVITY_MINIMUM_VERSION} or newer with native ACP; this installation reports ${version ?? "an unrecognized CLI version"}`,
    ...(version === undefined || readAntigravityVersion(version) === undefined ? {} : { installedVersion: version }), requiredVersion: ANTIGRAVITY_MINIMUM_VERSION,
  };
}

/** Direct readers must not assume installation() already checked the caller's executable. */
export async function antigravityVersionPreflight(installation: ExecutableInstallation, env: NodeJS.ProcessEnv,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<VersionRefusal | { readonly kind: "ready"; readonly timeoutMs: number }> {
  const deadline = Date.now() + options.timeoutMs;
  let { version } = installation;
  if (version === undefined) {
    const result = await runExecutable(installation.command, ["--version"], { env, ...options });
    assertRan(result, "Cannot read the Antigravity CLI version");
    version = result.ok ? readAntigravityVersion(result.stdout) : undefined;
  }
  return antigravityVersionRefusal(version) ?? { kind: "ready", timeoutMs: remainingMs(deadline, "Antigravity version preflight") };
}
