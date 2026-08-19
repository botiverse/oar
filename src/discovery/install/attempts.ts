import { firstLineVersion, runText } from "../cli.js";
import { resolveCommandOnPath } from "../host/windowsCommandResolution.js";
import type {
  DetectAttempt,
  InstallAttempt,
  InstallProbeContext,
  InstallTarget,
} from "./contract.js";

export function readCommandVersion(
  name: string,
  context: InstallProbeContext,
  args: readonly string[] = ["--version"],
): string | null {
  const bin = resolveCommandOnPath(name, context.commandDeps);
  if (!bin) return null;
  if (context.readVersion) return context.readVersion(bin);
  const result = runText(bin, args, { timeoutMs: 10_000 });
  return firstLineVersion(result.stdout) ?? firstLineVersion(result.stderr);
}

export function commandAttempts(
  names: readonly string[],
): (context: InstallProbeContext) => readonly InstallAttempt[] {
  return (context) =>
    names.map((name) => ({
      resolution: "command" as const,
      run: async () =>
        readCommandVersion(name, {
          ...context,
          commandDeps: { ...context.commandDeps, failMode: "throw" },
        }),
    }));
}

export function sdkAttempts(getVersion: () => string | null): readonly InstallAttempt[] {
  return [{ resolution: "sdk", run: async () => getVersion() }];
}

/** Walk ordered candidates; one failing candidate is evidence, not sweep failure. */
export async function runAttempts(
  target: InstallTarget,
  context: InstallProbeContext,
): Promise<DetectAttempt> {
  let probeErrorObserved = false;
  for (const attempt of target.attempts(context)) {
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
