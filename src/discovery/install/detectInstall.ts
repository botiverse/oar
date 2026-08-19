import { runAttempts } from "./attempts.js";
import type {
  DetectAttempt,
  InstallDescriptor,
  InstallDetectHooks,
  InstallDiagnostic,
  InstallEvidence,
  InstallProbeContext,
  InstallTarget,
} from "./contract.js";

const NONE_EVIDENCE: InstallEvidence = {
  resolution: "none",
  probeErrorObserved: false,
};

function diagnosticFor(refreshFailed: boolean): { diagnostic?: InstallDiagnostic } {
  return refreshFailed
    ? { diagnostic: { code: "windows_env_refresh_failed" } }
    : {};
}

function failed(runtime: string, refreshFailed: boolean): InstallDescriptor {
  return {
    runtime,
    state: "detect_failed",
    reason: "detect_failed",
    evidence: { resolution: "none", probeErrorObserved: true },
    ...diagnosticFor(refreshFailed),
  };
}

function missing(runtime: string, refreshFailed: boolean): InstallDescriptor {
  return {
    runtime,
    state: "not_installed",
    reason: "not_installed",
    evidence: NONE_EVIDENCE,
    ...diagnosticFor(refreshFailed),
  };
}

function probeContext(
  hooks: InstallDetectHooks,
  onRefreshFailed: () => void,
): InstallProbeContext {
  return {
    commandDeps: {
      ...hooks.commandResolve,
      onRefreshFailed: (code) => {
        onRefreshFailed();
        hooks.commandResolve?.onRefreshFailed?.(code);
      },
    },
    ...(hooks.readVersion ? { readVersion: hooks.readVersion } : {}),
    ...(hooks.runCommand ? { runCommand: hooks.runCommand } : {}),
  };
}

export async function detectInstallOne(
  target: InstallTarget,
  hooks: InstallDetectHooks = {},
): Promise<InstallDescriptor> {
  let windowsRefreshFailed = false;
  const context = probeContext(hooks, () => {
    windowsRefreshFailed = true;
  });

  let attempt: DetectAttempt | null = null;
  try {
    attempt = hooks.probeDetect
      ? await hooks.probeDetect(target)
      : await runAttempts(target, context);
  } catch {
    return failed(target.runtime, windowsRefreshFailed);
  }

  if (attempt === null) return failed(target.runtime, windowsRefreshFailed);

  const refreshFailed = windowsRefreshFailed || attempt.windowsRefreshFailed === true;
  if (attempt.version === null) {
    return attempt.probeErrorObserved
      ? failed(target.runtime, refreshFailed)
      : missing(target.runtime, refreshFailed);
  }

  const evidence: InstallEvidence = {
    resolution: attempt.resolution ?? "command",
    probeErrorObserved: attempt.probeErrorObserved,
  };
  const incompatibleReason = target.compatibility
    ? await target.compatibility(attempt.version, { probe: context, hooks })
    : null;
  if (incompatibleReason !== null) {
    return {
      runtime: target.runtime,
      state: "incompatible",
      version: attempt.version,
      reason: incompatibleReason,
      evidence,
      ...diagnosticFor(refreshFailed),
    };
  }

  return {
    runtime: target.runtime,
    state: "available",
    version: attempt.version,
    reason: "available",
    evidence,
    ...diagnosticFor(refreshFailed),
  };
}

/** One ordered row per registry id; target failures never sink the sweep. */
export async function detectInstallRegistered(
  targets: readonly InstallTarget[],
  registryIds: readonly string[],
  hooks: InstallDetectHooks = {},
): Promise<readonly InstallDescriptor[]> {
  const byRuntime = new Map(targets.map((target) => [target.runtime, target]));
  const rows: InstallDescriptor[] = [];
  for (const runtime of registryIds) {
    const target = byRuntime.get(runtime);
    if (!target) {
      rows.push(missing(runtime, false));
      continue;
    }
    try {
      rows.push(await detectInstallOne(target, hooks));
    } catch {
      rows.push(failed(runtime, false));
    }
  }
  return rows;
}
