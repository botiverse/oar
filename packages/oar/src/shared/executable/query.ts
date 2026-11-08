/**
 * A query's deadline bounds its answer, including startup and any awaited
 * cleanup. Abort the work at the deadline, but do not join its shutdown here.
 * The callback must stop its owned processes on abort and retain their normal
 * cleanup (including escalation). Promise.race observes a late rejection too.
 * With `timeoutResult`, return that result at the deadline instead of rejecting.
 * Login, logout and other operations that promise joined cleanup do not use
 * this boundary.
 */
export async function withQueryDeadline<T>(
  name: string,
  timeoutMs: number,
  query: (signal: AbortSignal) => Promise<T>,
  timeoutResult?: T,
): Promise<T> {
  const controller = new AbortController();
  const deadline = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    const error = new Error(`${name} timed out`);
    // Publish the deadline before abort handlers can settle a partial answer.
    if (timeoutResult === undefined) { deadline.reject(error); }
    else { deadline.resolve(timeoutResult); }
    controller.abort(error);
  }, timeoutMs);
  try {
    return await Promise.race([query(controller.signal), deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}
