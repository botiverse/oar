/**
 * Install-only registered-runtime detection.
 *
 * One row per registry id. Never calls models()/providers().
 * Default production path runs a per-candidate attempt list that:
 *   - uses Windows-aware resolveCommandOnPath for command candidates
 *   - records probeErrorObserved when an earlier candidate throws and a later one wins
 *   - surfaces windows_env_refresh_failed as a bounded diagnostic
 *
 * Resolution is the winning candidate's kind, not a second runtime-id table.
 */
import { spawnSync } from "node:child_process";
import { firstLineVersion, runText } from "./cli.js";
import type { RuntimeDriver } from "../backend/trait.js";
import {
  resolveCommandOnPath,
  type CommandResolveDeps,
} from "./host/windowsResolve.js";

export const GROK_STDIO_PROBE_ARGS = ["agent", "stdio", "--help"] as const;
export const GROK_STDIO_TIMEOUT_MS = 5_000;
export const MIN_SUPPORTED_OPENCODE_VERSION = "1.14.30";

export type InstallState = "available" | "not_installed" | "incompatible" | "detect_failed";
export type InstallResolution = "sdk" | "command" | "none";
export type InstallReason =
  | "available"
  | "not_installed"
  | "incompatible_stdio"
  | "incompatible_version"
  | "detect_failed";

export type InstallEvidence = {
  readonly resolution: InstallResolution;
  readonly probeErrorObserved: boolean;
};

export type InstallDiagnostic = {
  readonly code: "windows_env_refresh_failed" | InstallReason;
  readonly detail?: string;
};

export type InstallDescriptor = {
  readonly runtime: string;
  readonly state: InstallState;
  readonly version?: string;
  readonly reason: InstallReason;
  readonly evidence: InstallEvidence;
  readonly diagnostic?: InstallDiagnostic;
};

export type DetectAttempt = {
  readonly version: string | null;
  readonly probeErrorObserved: boolean;
  readonly resolution?: InstallResolution;
  readonly windowsRefreshFailed?: boolean;
};

export type InstallAttempt = {
  readonly resolution: Exclude<InstallResolution, "none">;
  run: () => Promise<string | null>;
};

export type InstallProbeCtx = {
  readonly commandDeps: CommandResolveDeps;
  readonly readVersion?: (bin: string) => string | null;
};

export type InstallAwareDriver = RuntimeDriver & {
  readonly installAttempts: (ctx: InstallProbeCtx) => readonly InstallAttempt[];
};

export type InstallDetectHooks = {
  /** Override production attempt runner. Tests may inject; default is required to be real. */
  probeDetect?: (driver: RuntimeDriver) => Promise<DetectAttempt>;
  grokStdioHelp?: (command: string) => Promise<boolean>;
  grokStdioGate?: boolean;
  opencodeMinVersion?: string | null;
  commandResolve?: CommandResolveDeps;
  /** Test seam: after PATH resolve, map the binary to a version without spawn. */
  readVersion?: (bin: string) => string | null;
};

export function parseLooseSemver(raw: string | undefined): [number, number, number] | null {
  if (!raw) return null;
  const m = raw.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

export function compareLooseSemver(a: string, b: string): number | null {
  const pa = parseLooseSemver(a);
  const pb = parseLooseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! > pb[i]!) return 1;
    if (pa[i]! < pb[i]!) return -1;
  }
  return 0;
}

export function isSupportedOpenCodeVersion(
  version: string,
  min: string = MIN_SUPPORTED_OPENCODE_VERSION,
): boolean {
  const cmp = compareLooseSemver(version, min);
  return cmp !== null && cmp >= 0;
}

export function isInstallAware(driver: RuntimeDriver): driver is InstallAwareDriver {
  return typeof (driver as InstallAwareDriver).installAttempts === "function";
}

export function readCommandVersion(
  name: string,
  ctx: InstallProbeCtx,
  args: readonly string[] = ["--version"],
): string | null {
  const bin = resolveCommandOnPath(name, ctx.commandDeps);
  if (!bin) return null;
  if (ctx.readVersion) return ctx.readVersion(bin);
  const r = runText(bin, [...args], { timeoutMs: 10_000 });
  return firstLineVersion(r.stdout) ?? firstLineVersion(r.stderr);
}

export function defaultCommandAttempts(driver: RuntimeDriver, ctx: InstallProbeCtx): InstallAttempt[] {
  return [
    {
      resolution: "command",
      run: async () =>
        readCommandVersion(driver.id, {
          ...ctx,
          commandDeps: { ...ctx.commandDeps, failMode: "throw" },
        }),
    },
    {
      resolution: "command",
      run: async () => {
        const d = await driver.detect();
        return d?.version ?? null;
      },
    },
  ];
}

export function sdkInstallAttempts(getVersion: () => string | null): InstallAttempt[] {
  return [
    {
      resolution: "sdk",
      run: async () => getVersion(),
    },
  ];
}

export function attemptsFor(driver: RuntimeDriver, ctx: InstallProbeCtx): readonly InstallAttempt[] {
  if (isInstallAware(driver)) return driver.installAttempts(ctx);
  return defaultCommandAttempts(driver, ctx);
}

/** Production default: walk candidates; a throw on an earlier one sets probeErrorObserved. */
export async function runInstallAttempts(
  driver: RuntimeDriver,
  ctx: InstallProbeCtx,
): Promise<DetectAttempt> {
  let probeErrorObserved = false;
  for (const attempt of attemptsFor(driver, ctx)) {
    try {
      const version = await attempt.run();
      if (version !== null) {
        return {
          version,
          probeErrorObserved,
          resolution: attempt.resolution,
          windowsRefreshFailed: false,
        };
      }
    } catch {
      probeErrorObserved = true;
    }
  }
  return {
    version: null,
    probeErrorObserved,
    resolution: "none",
    windowsRefreshFailed: false,
  };
}

function defaultGrokStdioHelp(command: string): Promise<boolean> {
  return Promise.resolve().then(() => {
    const r = spawnSync(command, [...GROK_STDIO_PROBE_ARGS], {
      encoding: "utf8",
      timeout: GROK_STDIO_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return r.status === 0;
  });
}

export async function detectInstallOne(
  driver: RuntimeDriver,
  hooks: InstallDetectHooks = {},
): Promise<InstallDescriptor> {
  let windowsRefreshFailed = false;
  const ctx: InstallProbeCtx = {
    commandDeps: {
      ...hooks.commandResolve,
      onRefreshFailed: (code) => {
        windowsRefreshFailed = true;
        hooks.commandResolve?.onRefreshFailed?.(code);
      },
    },
    ...(hooks.readVersion ? { readVersion: hooks.readVersion } : {}),
  };

  const probeDetect = hooks.probeDetect ?? ((d: RuntimeDriver) => runInstallAttempts(d, ctx));
  const grokStdioGate = hooks.grokStdioGate !== false;
  const grokStdioHelp = hooks.grokStdioHelp ?? defaultGrokStdioHelp;

  let attempt: DetectAttempt;
  try {
    attempt = await probeDetect(driver);
  } catch {
    return {
      runtime: driver.id,
      state: "detect_failed",
      reason: "detect_failed",
      evidence: { resolution: "none", probeErrorObserved: true },
      ...(windowsRefreshFailed ? { diagnostic: { code: "windows_env_refresh_failed" as const } } : {}),
    };
  }

  const refreshDiag = windowsRefreshFailed || attempt.windowsRefreshFailed
    ? ({ diagnostic: { code: "windows_env_refresh_failed" as const } } as const)
    : {};

  if (attempt.version === null) {
    if (attempt.probeErrorObserved) {
      return {
        runtime: driver.id,
        state: "detect_failed",
        reason: "detect_failed",
        evidence: { resolution: "none", probeErrorObserved: true },
        ...refreshDiag,
      };
    }
    return {
      runtime: driver.id,
      state: "not_installed",
      reason: "not_installed",
      evidence: { resolution: "none", probeErrorObserved: false },
      ...refreshDiag,
    };
  }

  const version = attempt.version;
  const evidence: InstallEvidence = {
    resolution: attempt.resolution ?? "command",
    probeErrorObserved: attempt.probeErrorObserved,
  };

  if (driver.id === "grok" && grokStdioGate) {
    const bin = resolveCommandOnPath("grok", ctx.commandDeps) ?? "grok";
    let ok = false;
    try {
      ok = await grokStdioHelp(bin);
    } catch {
      ok = false;
    }
    if (!ok) {
      return {
        runtime: "grok",
        state: "incompatible",
        version,
        reason: "incompatible_stdio",
        evidence,
        ...refreshDiag,
      };
    }
  }

  if (driver.id === "opencode") {
    const min = hooks.opencodeMinVersion === undefined
      ? MIN_SUPPORTED_OPENCODE_VERSION
      : hooks.opencodeMinVersion;
    if (min !== null && !isSupportedOpenCodeVersion(version, min)) {
      return {
        runtime: "opencode",
        state: "incompatible",
        version,
        reason: "incompatible_version",
        evidence,
        ...refreshDiag,
      };
    }
  }

  return {
    runtime: driver.id,
    state: "available",
    version,
    reason: "available",
    evidence,
    ...refreshDiag,
  };
}

export async function detectInstallRegistered(
  drivers: readonly RuntimeDriver[],
  registryIds: readonly string[],
  hooks: InstallDetectHooks = {},
): Promise<readonly InstallDescriptor[]> {
  const byId = new Map(drivers.map((d) => [d.id, d]));
  const out: InstallDescriptor[] = [];
  for (const id of registryIds) {
    const driver = byId.get(id);
    if (!driver) {
      out.push({
        runtime: id,
        state: "not_installed",
        reason: "not_installed",
        evidence: { resolution: "none", probeErrorObserved: false },
      });
      continue;
    }
    try {
      out.push(await detectInstallOne(driver, hooks));
    } catch {
      out.push({
        runtime: id,
        state: "detect_failed",
        reason: "detect_failed",
        evidence: { resolution: "none", probeErrorObserved: true },
      });
    }
  }
  return out;
}
