import type { CommandRunner } from "../cli.js";
import type { CommandResolveDeps } from "../host/windowsResolve.js";

export type InstallState =
  | "available"
  | "not_installed"
  | "incompatible"
  | "detect_failed";

export type InstallResolution = "sdk" | "command" | "none";

export type InstallReason =
  | "available"
  | "not_installed"
  | "incompatible_stdio"
  | "incompatible_version"
  | "detect_failed";

export interface InstallEvidence {
  readonly resolution: InstallResolution;
  readonly probeErrorObserved: boolean;
}

export interface InstallDiagnostic {
  readonly code: "windows_env_refresh_failed" | InstallReason;
  readonly detail?: string;
}

export interface InstallDescriptor {
  readonly runtime: string;
  readonly state: InstallState;
  readonly version?: string;
  readonly reason: InstallReason;
  readonly evidence: InstallEvidence;
  readonly diagnostic?: InstallDiagnostic;
}

/** Internal result of resolving/version-probing the candidate list. */
export interface DetectAttempt {
  readonly version: string | null;
  readonly probeErrorObserved: boolean;
  readonly resolution?: InstallResolution;
  readonly windowsRefreshFailed?: boolean;
}

/** One ordered way of finding an install. Candidate errors do not sink the sweep. */
export interface InstallAttempt {
  readonly resolution: Exclude<InstallResolution, "none">;
  run(): Promise<string | null>;
}

/** Host mechanisms available to install candidates. No product policy lives here. */
export interface InstallProbeContext {
  readonly commandDeps: CommandResolveDeps;
  readonly readVersion?: (bin: string) => string | null;
  readonly runCommand?: CommandRunner;
}

export interface InstallPolicyContext {
  readonly probe: InstallProbeContext;
  readonly hooks: InstallDetectHooks;
}

/**
 * Runtime-owned eligibility policy. Returning a reason rejects an otherwise
 * resolved/versioned candidate as incompatible.
 */
export type InstallCompatibilityPolicy = (
  version: string,
  context: InstallPolicyContext,
) => Promise<Extract<InstallReason, "incompatible_stdio" | "incompatible_version"> | null>;

/**
 * The install-detection boundary. It is intentionally separate from
 * RuntimeDriver: install discovery never needs models(), sessions, or events.
 */
export interface InstallTarget {
  readonly runtime: string;
  attempts(context: InstallProbeContext): readonly InstallAttempt[];
  readonly compatibility?: InstallCompatibilityPolicy;
}

export interface InstallDetectHooks {
  /** Override attempt execution. Tests may inject; production walks target.attempts(). */
  readonly probeDetect?: (target: InstallTarget) => Promise<DetectAttempt>;
  readonly grokStdioHelp?: (command: string) => Promise<boolean>;
  readonly grokStdioGate?: boolean;
  readonly opencodeMinVersion?: string | null;
  readonly commandResolve?: CommandResolveDeps;
  /** After PATH resolution, map the binary to a version without spawning. */
  readonly readVersion?: (bin: string) => string | null;
  /** Raw command runner. It supplies results, never precomputed eligibility. */
  readonly runCommand?: CommandRunner;
}
