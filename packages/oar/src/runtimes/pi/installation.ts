import type { InstallationProbe, InstallationSnapshot } from "../../contracts/installation.js";
import { checkHostEnvironment, currentHostEnvironment, type HostEnvironment } from "../../shared/host-environment.js";
import { executableInstallation } from "../../shared/installation.js";
import type { PiRuntimeOptions } from "./options.js";
import { PI_RPC_MINIMUM_VERSION } from "./rpc/version.js";

const SDK_PACKAGE = "@earendil-works/pi-coding-agent";
const AI_PACKAGE = "@earendil-works/pi-ai";
const RPC_ENTRY = "@earendil-works/pi-coding-agent/rpc-entry";

async function packageAvailable(
  host: HostEnvironment,
  specifier: typeof SDK_PACKAGE | typeof AI_PACKAGE,
  allowImportFallback: boolean,
): Promise<boolean> {
  if (host.resolveModule(specifier) !== null) { return true; }
  if (!allowImportFallback) { return false; }
  try {
    // String LITERALS, not variables: bundlers only compile in (and resolve)
    // literal specifiers, and this fallback exists for single-file hosts.
    await (specifier === SDK_PACKAGE ? import("@earendil-works/pi-coding-agent") : import("@earendil-works/pi-ai"));
    return true;
  } catch {
    return false;
  }
}

async function missingPiPeers(host: HostEnvironment, allowImportFallback: boolean): Promise<string[]> {
  const missing: string[] = [];
  if (!await packageAvailable(host, SDK_PACKAGE, allowImportFallback)) { missing.push(SDK_PACKAGE); }
  if (!await packageAvailable(host, AI_PACKAGE, allowImportFallback)) { missing.push(AI_PACKAGE); }
  return missing;
}

function parsePiVersion(raw: string): string | undefined {
  const trimmed = raw.trim();
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[A-Za-z\d.-]+)?$/u.test(trimmed) ? trimmed : undefined;
}

/**
 * Probe Pi availability for in-process or native RPC subprocess execution:
 * - Every Pi mode requires optional dependencies `@earendil-works/pi-coding-agent`
 *   and `@earendil-works/pi-ai` in the host, reporting `unsupported` with code
 *   `dependency_missing` when either is absent (for example, when installed with
 *   `--omit=optional`).
 * - Subprocess without an explicit `command` also requires a non-SEA, non-Electron
 *   Node host and a resolvable `@earendil-works/pi-coding-agent/rpc-entry` on disk.
 * - Subprocess with an explicit `command` delegates discovery, caching, and
 *   version-floor enforcement (`>= 1.4.0`) to `executableInstallation`, then
 *   still checks both host packages (used for session lookup, project-package
 *   checks, and context-overflow detection).
 */
export function piInstallationFor(
  runtimeOptions: PiRuntimeOptions = {},
  hostOverride?: Partial<HostEnvironment>,
): InstallationProbe {
  const allowImportFallback = hostOverride?.resolveModule === undefined;
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
      const missing = await missingPiPeers(host, allowImportFallback);
      if (missing.length > 0) {
        return {
          kind: "unsupported",
          code: "dependency_missing",
          reason: `Pi RPC requires ${missing.join(" and ")} in the host for session lookup, project-package checks, and context-overflow detection, even when running an explicit command. Install ${missing.join(" ")} in your project.`,
        };
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
          reason: `A single-file host must provide command for Pi subprocess execution: createPiRuntime({ execution: "subprocess", command, args }). OAR could not resolve ${RPC_ENTRY} (install @earendil-works/pi-coding-agent and @earendil-works/pi-ai if omitted).`,
        },
      }, host);
      if (refusal !== null) { return refusal; }
    }
    const missing = await missingPiPeers(host, allowImportFallback);
    if (missing.length > 0) {
      const label = runtimeOptions.execution === "subprocess" ? "Pi RPC" : "Pi";
      return {
        kind: "unsupported",
        code: "dependency_missing",
        reason: `${label} requires optional ${missing.length === 1 ? "dependency" : "dependencies"} ${missing.join(" and ")}. Install ${missing.join(" ")} (or install @botiverse/oar without omitting optional dependencies).`,
      };
    }
    return { kind: "available", via: "bundled" };
  };
}

export const piInstallation: InstallationProbe = piInstallationFor();
