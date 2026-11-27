import path from "node:path";
import type { AvailableInstallation, InstallationProbe, InstallationSnapshot } from "../../contracts/installation.js";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";
import { environmentHome } from "../../shared/environment-home.js";
import { resolveExecutable } from "../../shared/executable/index.js";
import { checkHostEnvironment, currentHostEnvironment, type HostEnvironment } from "../../shared/host-environment.js";
import { npmGlobalBin, npmGlobalPrefix } from "../../shared/install-npm.js";
import { executableInstallation, type ExecutableFallbacks, type ExecutableInstallationOptions } from "../../shared/installation.js";
import type { PiRuntimeOptions } from "./options.js";
import { PI_RPC_MINIMUM_VERSION } from "./rpc/version.js";

const SDK_PACKAGE = "@earendil-works/pi-coding-agent";
const AI_PACKAGE = "@earendil-works/pi-ai";
const RPC_ENTRY = "@earendil-works/pi-coding-agent/rpc-entry";

/** True only when subprocess execution targets the standalone `pi` CLI without host prefix args. */
export function isStandalonePiCommand(options: PiRuntimeOptions): boolean {
  return options.execution === "subprocess" && options.command === "pi" && options.args === undefined;
}

/**
 * Match the runtime mode configuration against the caller's `AvailableInstallation`
 * and carry forward the probed executable command for explicit-command RPC.
 */
export function resolvePiRpcInstallation(
  runtime: PiRuntimeOptions,
  installation: AvailableInstallation,
): { readonly ok: true; readonly runtime: PiRuntimeOptions } | { readonly ok: false; readonly reason: string } {
  if (runtime.command !== undefined) {
    if (installation.via !== "executable") {
      return { ok: false, reason: "Pi RPC with an explicit command requires an executable installation" };
    }
    return {
      ok: true,
      runtime: {
        ...runtime,
        execution: "subprocess",
        command: installation.command,
      },
    };
  }
  if (installation.via !== "bundled") {
    return { ok: false, reason: "Pi RPC needs the bundled SDK installation" };
  }
  return { ok: true, runtime };
}

/** Standard native-installer and GUI-missed user locations for the standalone `pi` CLI. */
export function piInstalledExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  home?: string,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): readonly string[] {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const baseHome = home ?? environmentValue(env, platform === "win32" ? "USERPROFILE" : "HOME", platform) ?? environmentHome(env);
  const configured = [
    environmentValue(env, "OAR_PI_AGENT_DIR", platform),
    environmentValue(env, "PI_CODING_AGENT_DIR", platform),
  ].find((value) => value !== undefined && value.length > 0);
  const agentDir = configured ?? paths.join(baseHome, ".pi", "agent");
  if (platform === "win32") {
    return [
      paths.join(baseHome, ".local", "bin", "pi.cmd"),
      paths.join(baseHome, ".local", "bin", "pi.exe"),
      paths.join(agentDir, "install", "pi.cmd"),
      paths.join(agentDir, "install", "pi.exe"),
      paths.join(agentDir, "install", "bin", "pi.cmd"),
      paths.join(agentDir, "install", "bin", "pi.exe"),
    ];
  }
  return [
    paths.join(baseHome, ".local", "bin", "pi"),
    paths.join(agentDir, "install", "pi"),
    paths.join(agentDir, "install", "bin", "pi"),
  ];
}

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

function piCommandProbeOptions(args?: readonly string[]): ExecutableInstallationOptions {
  return {
    ...(args === undefined ? {} : { argsPrefix: args }),
    versionTimeoutMs: 15_000,
    versionPolicy: {
      label: "Pi RPC",
      lines: [{ min: PI_RPC_MINIMUM_VERSION, stableOnly: true }],
      required: PI_RPC_MINIMUM_VERSION,
      parseVersion: parsePiVersion,
      formatReason: (_command, installed) =>
        `Pi RPC requires at least ${PI_RPC_MINIMUM_VERSION}; the selected runtime reports ${installed ?? "no readable version"}`,
    },
  };
}

async function probeNpmGlobalPi(
  probeOptions: Parameters<InstallationProbe>[0],
  commandProbeOptions: ExecutableInstallationOptions,
): Promise<InstallationSnapshot> {
  const env = sessionEnvironment(probeOptions?.env);
  const npm = resolveExecutable("npm", env);
  if (npm === null) { return { kind: "not_found" }; }
  const prefix = await npmGlobalPrefix(npm, env).catch((): null => null);
  if (prefix === null) { return { kind: "not_found" }; }
  const command = path.join(npmGlobalBin(prefix), process.platform === "win32" ? "pi.cmd" : "pi");
  return executableInstallation("", command, [], undefined, commandProbeOptions)(probeOptions);
}

/**
 * Probe Pi availability for in-process or native RPC subprocess execution:
 * - Every Pi mode requires optional dependencies `@earendil-works/pi-coding-agent`
 *   and `@earendil-works/pi-ai` in the host, reporting `unsupported` with code
 *   `dependency_missing` when either is absent (for example, when installed with
 *   `--omit=optional`).
 * - Subprocess without an explicit `command` also requires a non-SEA, non-Electron
 *   Node host and a resolvable `@earendil-works/pi-coding-agent/rpc-entry` on disk,
 *   returning `available` with `via: "bundled"`.
 * - Subprocess with an explicit `command` delegates discovery, caching, and
 *   version-floor enforcement (`>= 1.4.0`) to `executableInstallation`, checks
 *   both host packages (used for session lookup, project-package checks, and
 *   context-overflow detection), and returns `available` with `via: "executable"`.
 *   When configured as standalone `command: "pi"` (no `args`), off-PATH user
 *   locations (`~/.local/bin`, agent install dir, and `npm prefix -g`) are also checked.
 */
export function piInstallationFor(
  runtimeOptions: PiRuntimeOptions = {},
  hostOverride?: Partial<HostEnvironment>,
): InstallationProbe {
  const allowImportFallback = hostOverride?.resolveModule === undefined;
  const standalone = isStandalonePiCommand(runtimeOptions);
  const commandProbeOptions = piCommandProbeOptions(runtimeOptions.args);
  const fallbacks: ExecutableFallbacks = standalone
    ? (env) => piInstalledExecutableCandidates(process.platform, environmentHome(env), env)
    : [];
  const commandProbe = runtimeOptions.execution === "subprocess" && runtimeOptions.command !== undefined
    ? executableInstallation("", runtimeOptions.command, fallbacks, undefined, commandProbeOptions)
    : null;

  return async (probeOptions = {}): Promise<InstallationSnapshot> => {
    const host: HostEnvironment = { ...currentHostEnvironment(), ...hostOverride };
    if (commandProbe !== null) {
      const missing = await missingPiPeers(host, allowImportFallback);
      if (missing.length > 0) {
        return {
          kind: "unsupported",
          code: "dependency_missing",
          reason: `Pi RPC requires ${missing.join(" and ")} in the host for session lookup, project-package checks, and context-overflow detection, even when running an explicit command. Install ${missing.join(" ")} in your project.`,
        };
      }
      let snapshot = await commandProbe(probeOptions);
      if (snapshot.kind === "not_found" && standalone) {
        snapshot = await probeNpmGlobalPi(probeOptions, commandProbeOptions);
      }
      return snapshot;
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
