/**
 * Public facade for install-only detection.
 *
 * Contracts, generic attempt execution, runtime policies, host candidate
 * implementations, and sweep orchestration live in separate modules. Keep this
 * file intentionally boring: consumers get one stable import path without
 * turning it into the place every implementation concern accumulates.
 */
export type {
  DetectAttempt,
  InstallAttempt,
  InstallCompatibilityPolicy,
  InstallDescriptor,
  InstallDetectHooks,
  InstallDiagnostic,
  InstallEvidence,
  InstallPolicyContext,
  InstallProbeContext,
  InstallReason,
  InstallResolution,
  InstallState,
  InstallTarget,
} from "./install/contract.js";

export {
  commandAttempts,
  readCommandVersion,
  runAttempts,
  sdkAttempts,
} from "./install/attempts.js";

export {
  compareLooseSemver,
  GROK_STDIO_PROBE_ARGS,
  GROK_STDIO_TIMEOUT_MS,
  isSupportedOpenCodeVersion,
  MIN_SUPPORTED_OPENCODE_VERSION,
  parseLooseSemver,
} from "./install/policies.js";

export {
  detectInstallOne,
  detectInstallRegistered,
} from "./install/detectInstall.js";
