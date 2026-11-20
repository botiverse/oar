import type { InstallationProbe, InstallationSnapshot } from "../../contracts/installation.js";
import { checkHostEnvironment, currentHostEnvironment, type HostEnvironment } from "../../shared/host-environment.js";
import { executableInstallation } from "../../shared/installation.js";
import type { PiRuntimeOptions } from "./options.js";
import { PI_RPC_MINIMUM_VERSION } from "./rpc/version.js";

const SDK_PACKAGE = "@earendil-works/pi-coding-agent";
const RPC_ENTRY = "@earendil-works/pi-coding-agent/rpc-entry";

async function sdkLoads(): Promise<boolean> {
  try {
    // A string LITERAL, not SDK_PACKAGE: bundlers only compile in (and
    // resolve) literal specifiers, and this fallback exists for bundles.
    await import("@earendil-works/pi-coding-agent");
    return true;
  } catch {
    return false;
  }
}

async function hasBundledSdk(host: HostEnvironment): Promise<boolean> {
  return host.resolveModule(SDK_PACKAGE) !== null || await sdkLoads();
}

function parsePiVersion(raw: string): string | undefined {
  const trimmed = raw.trim();
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[A-Za-z\d.-]+)?$/u.test(trimmed) ? trimmed : undefined;
}

/**
 * Probe Pi availability for in-process or native RPC subprocess execution:
 * - In-process checks that `@earendil-works/pi-coding-agent` resolves or loads.
 * - Subprocess without an explicit `command` requires a non-SEA, non-Electron
 *   Node host and a resolvable `@earendil-works/pi-coding-agent/rpc-entry` on disk.
 * - Subprocess with an explicit `command` delegates discovery, caching, and
 *   version-floor enforcement (`>= 1.4.0`) to `executableInstallation`.
 */
export function piInstallationFor(
  runtimeOptions: PiRuntimeOptions = {},
  hostOverride?: Partial<HostEnvironment>,
): InstallationProbe {
  const commandProbe = runtimeOptions.execution === "subprocess" && runtimeOptions.command !== undefined
    ? executableInstallation("", runtimeOptions.command, [], undefined, {
      ...(runtimeOptions.args === undefined ? {} : { argsPrefix: runtimeOptions.args }),
      versionTimeoutMs: 15_000,
      versionPolicy: {
        label: "Pi RPC",
        lines: [{ min: PI_RPC_MINIMUM_VERSION, stableOnly: true }],
        required: PI_RPC_MINIMUM_VERSION,
        parseVersion: parsePiVersion,
        formatReason: (_command, installed) =>
          `Pi RPC requires at least ${PI_RPC_MINIMUM_VERSION}; the selected runtime reports ${installed ?? "no readable version"}`,
      },
    })
    : null;

  return async (probeOptions = {}): Promise<InstallationSnapshot> => {
    const host: HostEnvironment = { ...currentHostEnvironment(), ...hostOverride };
    if (commandProbe !== null) {
      const snapshot = await commandProbe(probeOptions);
      if (snapshot.kind !== "available") { return snapshot; }
      if (!await hasBundledSdk(host)) {
        return { kind: "unsupported", code: "dependency_missing", reason: "Pi RPC requires @earendil-works/pi-coding-agent to be available in the host" };
      }
      return { kind: "available", via: "bundled" };
    }
    if (runtimeOptions.execution === "subprocess") {
      const refusal = checkHostEnvironment({
        forbidCompiledSingleExecutable: {
          reason: 'A single-file host must provide command for Pi subprocess execution: createPiRuntime({ execution: "subprocess", command, args }).',
        },
        forbidElectron: {
          reason: 'Pi RPC without an explicit command cannot run from an Electron host; pass createPiRuntime({ execution: "subprocess", command }).',
        },
        requiredModule: {
          specifier: RPC_ENTRY,
          reason: `A single-file host must provide command for Pi subprocess execution: createPiRuntime({ execution: "subprocess", command, args }). OAR could not resolve ${RPC_ENTRY}.`,
        },
      }, host);
      if (refusal !== null) { return refusal; }
    }
    return await hasBundledSdk(host) ? { kind: "available", via: "bundled" } : { kind: "not_found" };
  };
}

export const piInstallation: InstallationProbe = piInstallationFor();
