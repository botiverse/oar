/**
 * Install-only registered-runtime detection.
 *
 * One row per registry id. Calls only `detect()` (or an injected equivalent).
 * Never calls models()/providers().
 *
 * State is independent of the models four-state:
 *   available | not_installed | incompatible | detect_failed
 */
import type { RuntimeDriver } from "../backend/trait.js";
import { spawnSync } from "node:child_process";
import { which } from "./cli.js";

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
  /** Closed/bounded; never a path, command line, exception, URL, or token. */
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
};

export type InstallDetectHooks = {
  /**
   * Availability probe. Default: driver.detect() only.
   * Must never call models()/providers().
   */
  probeDetect?: (driver: RuntimeDriver) => Promise<DetectAttempt>;
  /** Grok compatibility: `grok agent stdio --help` + 5s. Default: live spawn. */
  grokStdioHelp?: (command: string) => Promise<boolean>;
  /** When false, Grok skips the stdio gate (mutation target). Default true. */
  grokStdioGate?: boolean;
  /**
   * OpenCode minimum version. Omit to use MIN_SUPPORTED_OPENCODE_VERSION.
   * Pass `null` to disable the gate (mutation target).
   */
  opencodeMinVersion?: string | null;
  /** Command locator (Windows-aware). Default: which(). */
  resolveCommand?: (name: string) => string | null;
};

const SDK_RUNTIME_IDS = new Set(["pi", "kimi"]);

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

export function resolutionOf(runtime: string, installed: boolean): InstallResolution {
  if (!installed) return "none";
  return SDK_RUNTIME_IDS.has(runtime) ? "sdk" : "command";
}

function defaultProbeDetect(driver: RuntimeDriver): Promise<DetectAttempt> {
  return driver.detect().then(
    (v) => ({ version: v?.version ?? null, probeErrorObserved: false }),
    () => ({ version: null, probeErrorObserved: true }),
  );
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

function row(partial: InstallDescriptor): InstallDescriptor {
  return partial;
}

export async function detectInstallOne(
  driver: RuntimeDriver,
  hooks: InstallDetectHooks = {},
): Promise<InstallDescriptor> {
  const probeDetect = hooks.probeDetect ?? defaultProbeDetect;
  const grokStdioGate = hooks.grokStdioGate !== false;
  const opencodeMin = hooks.opencodeMinVersion;
  const grokStdioHelp = hooks.grokStdioHelp ?? defaultGrokStdioHelp;
  const resolveCommand = hooks.resolveCommand ?? which;

  let attempt: DetectAttempt;
  try {
    attempt = await probeDetect(driver);
  } catch {
    return row({
      runtime: driver.id,
      state: "detect_failed",
      reason: "detect_failed",
      evidence: { resolution: resolutionOf(driver.id, false), probeErrorObserved: true },
    });
  }

  if (attempt.version === null) {
    if (attempt.probeErrorObserved) {
      return row({
        runtime: driver.id,
        state: "detect_failed",
        reason: "detect_failed",
        evidence: { resolution: "none", probeErrorObserved: true },
      });
    }
    return row({
      runtime: driver.id,
      state: "not_installed",
      reason: "not_installed",
      evidence: { resolution: "none", probeErrorObserved: false },
    });
  }

  const version = attempt.version;
  const evidenceBase = {
    resolution: resolutionOf(driver.id, true),
    probeErrorObserved: attempt.probeErrorObserved,
  } as const;

  if (driver.id === "grok" && grokStdioGate) {
    const bin = resolveCommand("grok") ?? "grok";
    let ok = false;
    try {
      ok = await grokStdioHelp(bin);
    } catch {
      ok = false;
    }
    if (!ok) {
      return row({
        runtime: "grok",
        state: "incompatible",
        version,
        reason: "incompatible_stdio",
        evidence: evidenceBase,
      });
    }
  }

  if (driver.id === "opencode") {
    const min = opencodeMin === undefined ? MIN_SUPPORTED_OPENCODE_VERSION : opencodeMin;
    if (min !== null && !isSupportedOpenCodeVersion(version, min)) {
      return row({
        runtime: "opencode",
        state: "incompatible",
        version,
        reason: "incompatible_version",
        evidence: evidenceBase,
      });
    }
  }

  return row({
    runtime: driver.id,
    state: "available",
    version,
    reason: "available",
    evidence: evidenceBase,
  });
}

/**
 * One row per registry id. Missing driver → not_installed.
 * A throwing driver is detect_failed; the sweep continues.
 */
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
        evidence: { resolution: resolutionOf(id, false), probeErrorObserved: true },
      });
    }
  }
  return out;
}
