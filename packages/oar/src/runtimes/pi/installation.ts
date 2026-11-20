import type { InstallationProbe, InstallationSnapshot } from "../../contracts/installation.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { assertRan } from "../../shared/executable/diagnostics.js";
import { runExecutable } from "../../shared/executable/index.js";
import { checkHostEnvironment, currentHostEnvironment, type HostEnvironment } from "../../shared/host-environment.js";
import { locateExecutable } from "../../shared/installation.js";
import type { PiRuntimeOptions } from "./options.js";
import { assertPiRpcVersion, PiRpcVersionError } from "./rpc/version.js";

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

async function probeExplicitPiCommand(
  command: string,
  args: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
  host: HostEnvironment,
): Promise<InstallationSnapshot> {
  const located = locateExecutable(command, env);
  if (located === null) { return { kind: "not_found" }; }
  const result = await runExecutable(located, [...args, "--version"], { env, timeoutMs: 15_000 });
  assertRan(result, "Cannot read the Pi RPC executable version");
  const actual = result.ok ? result.stdout.trim() : "";
  try {
    assertPiRpcVersion(actual);
  } catch (error) {
    if (error instanceof PiRpcVersionError) {
      return { ...error.refusal, via: "executable", command: located };
    }
    throw error;
  }
  if (!await hasBundledSdk(host)) {
    return { kind: "unsupported", code: "dependency_missing", reason: "Pi RPC requires @earendil-works/pi-coding-agent to be available in the host" };
  }
  return { kind: "available", via: "bundled" };
}

/**
 * Probe Pi availability for in-process or native RPC subprocess execution:
 * - In-process checks that `@earendil-works/pi-coding-agent` resolves or loads.
 * - Subprocess without an explicit `command` requires a non-SEA, non-Electron
 *   Node host and a resolvable `@earendil-works/pi-coding-agent/rpc-entry` on disk.
 * - Subprocess with an explicit `command` locates that command and checks its
 *   `--version` against `PI_RPC_MINIMUM_VERSION`.
 */
export function piInstallationFor(
  runtimeOptions: PiRuntimeOptions = {},
  hostOverride?: Partial<HostEnvironment>,
): InstallationProbe {
  return async (probeOptions = {}): Promise<InstallationSnapshot> => {
    const host: HostEnvironment = { ...currentHostEnvironment(), ...hostOverride };
    if (runtimeOptions.execution === "subprocess") {
      if (runtimeOptions.command !== undefined) {
        const env = sessionEnvironment(probeOptions.env);
        return probeExplicitPiCommand(runtimeOptions.command, runtimeOptions.args ?? [], env, host);
      }
      const refusal = checkHostEnvironment({
        forbidCompiledSingleExecutable: {
          reason: 'Pi RPC without an explicit command cannot run from a compiled single executable (Node SEA or Bun standalone); pass createPiRuntime({ execution: "subprocess", command })',
        },
        forbidElectron: {
          reason: 'Pi RPC without an explicit command cannot run from an Electron host; pass createPiRuntime({ execution: "subprocess", command })',
        },
        requiredModule: {
          specifier: RPC_ENTRY,
          reason: `Pi RPC requires a resolvable ${RPC_ENTRY} module on disk`,
        },
      }, host);
      if (refusal !== null) { return refusal; }
    }
    return await hasBundledSdk(host) ? { kind: "available", via: "bundled" } : { kind: "not_found" };
  };
}

export const piInstallation: InstallationProbe = piInstallationFor();
