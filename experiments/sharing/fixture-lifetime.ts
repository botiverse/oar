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
  try { return await observe(fixture); }
  finally { await fixture.stop(); }
}
