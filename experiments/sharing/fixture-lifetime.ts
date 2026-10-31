/** Own every acquired probe resource, including partially constructed fixtures. */
export interface StoppableFixture { readonly stop: () => Promise<void> }

export async function probeFixture<T>(create: (defer: (cleanup: () => void | Promise<void>) => void) => Promise<T>): Promise<T & StoppableFixture> {
  const cleanups: (() => void | Promise<void>)[] = [];
  let stopped: Promise<void> | undefined = undefined;
  const stop = async (): Promise<void> => {
    stopped ??= (async (): Promise<void> => {
      const errors: unknown[] = [];
      for (const cleanup of cleanups.toReversed()) {
        // oxlint-disable-next-line no-await-in-loop -- Release resources in reverse acquisition order, attempting every cleanup.
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      if (errors.length > 0) { throw new AggregateError(errors, "Probe cleanup failed"); }
    })();
    await stopped;
  };
  try { return { ...await create((cleanup) => { cleanups.push(cleanup); }), stop }; }
  catch (error) {
    try { await stop(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Probe setup and cleanup failed", { cause: cleanupError }); }
    throw error;
  }
}

export async function usingProbeFixture<T extends StoppableFixture, R>(create: () => Promise<T>, observe: (fixture: T) => Promise<R>): Promise<R> {
  const fixture = await create();
  const result = await (async (): Promise<R> => { const value = await observe(fixture); return value; })().catch(async (error: unknown): Promise<never> => {
    try { await fixture.stop(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Probe observation and cleanup failed", { cause: cleanupError }); }
    throw error;
  });
  await fixture.stop();
  return result;
}

/** Attempt every evidence source even when observation or another source fails. */
export async function preservingProbeEvidence(observe: () => Promise<void>, collect: readonly (() => void | Promise<void>)[]): Promise<void> {
  const errors: unknown[] = [];
  try { await observe(); } catch (error) { errors.push(error); }
  for (const read of collect) {
    // oxlint-disable-next-line no-await-in-loop -- Retain independent evidence in a stable order, attempting every source.
    try { await read(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) { throw errors[0]; }
  if (errors.length > 1) { throw new AggregateError(errors, "Probe observation and evidence collection failed"); }
}

/** String(AggregateError) omits its causes; evidence must retain each failure. */
export function probeErrorText(error: unknown): string {
  return error instanceof AggregateError
    ? `${String(error)}: [${error.errors.map((cause: unknown) => probeErrorText(cause)).join("; ")}]`
    : String(error);
}
