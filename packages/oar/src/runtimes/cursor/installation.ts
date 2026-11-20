import { checkHostEnvironment, currentHostEnvironment, type HostEnvironment } from "../../shared/host-environment.js";
import { refuseReaderEnvironment } from "../../shared/refuse-environment.js";
import type { InstallationProbe } from "../../contracts/installation.js";

/** The platforms `@cursor/sdk` 1.4.1 ships a native companion package for (`optionalDependencies`). */
const PLATFORMS: ReadonlySet<string> = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);

/** Minimum Node version declared by `@cursor/sdk` 1.4.1 (`package.json` `engines.node`: `">=22.13"`). */
export const CURSOR_MIN_NODE_VERSION = "22.13.0";

export interface CursorInstallationForOptions {
  readonly sdkModule?: string;
  readonly host?: Partial<HostEnvironment>;
}

/**
 * Cursor runs through `@cursor/sdk`, in process or in a Node subprocess
 * (`createCursorRuntime`). Both modes require a platform with a native
 * companion package and Node 22.13+; subprocess mode also requires a non-SEA,
 * non-standalone-Bun host and a resolvable `sdkModule`. In-process mode does
 * not call the host's `sdk()` loader during discovery.
 */
export function cursorInstallationFor(
  platform: string,
  arch: string,
  execution: "in_process" | "subprocess" = "in_process",
  probeConfig: CursorInstallationForOptions = {},
): InstallationProbe {
  return async (options = {}) => {
    // In subprocess mode a session's environment is the child's; this probe reads none either way.
    if (execution === "in_process") { refuseReaderEnvironment(options.env, "Cursor installation probes the host SDK"); }
    await Promise.resolve();
    const host: HostEnvironment = { ...currentHostEnvironment(), ...probeConfig.host, platform, arch };
    const refusal = checkHostEnvironment({
      platforms: { supported: PLATFORMS, label: "@cursor/sdk" },
      minNodeVersion: { version: CURSOR_MIN_NODE_VERSION, label: "@cursor/sdk" },
      ...(execution === "subprocess"
        ? {
          forbidCompiledSingleExecutable: {
            reason: "Cursor subprocess mode cannot run from a compiled single executable (Node SEA or Bun standalone); use in-process mode instead",
          },
          ...(probeConfig.sdkModule === undefined ? {} : {
            requiredModule: {
              specifier: probeConfig.sdkModule,
              reason: `Cursor subprocess mode could not resolve sdkModule (${probeConfig.sdkModule})`,
            },
          }),
        }
        : {}),
    }, host);
    return refusal ?? { kind: "available", via: "bundled" };
  };
}

export const cursorInstallation: InstallationProbe = cursorInstallationFor(process.platform, process.arch);
