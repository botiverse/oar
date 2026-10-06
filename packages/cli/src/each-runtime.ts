import type { Runtime } from "@botiverse/oar";

/** A runtime whose probe or read rejected (a timeout, a network error): its reason in place of its report. */
export interface RuntimeFailure {
  readonly runtimeId: string;
  readonly error: string;
}

/**
 * Read every runtime at once. One that rejects reports its `error` while the
 * others still report, as `oar upgrade` and `oar login --status` do, so one
 * stuck runtime never hides the rest.
 */
export async function readEach<T>(
  runtimes: readonly Runtime[],
  read: (runtime: Runtime) => Promise<T>,
): Promise<(T | RuntimeFailure)[]> {
  const reports = await Promise.all(runtimes.map(async (runtime) => {
    try {
      return await read(runtime);
    } catch (error) {
      return { runtimeId: runtime.id, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return reports;
}

export function isRuntimeFailure(report: object): report is RuntimeFailure {
  return "error" in report && typeof report.error === "string";
}
