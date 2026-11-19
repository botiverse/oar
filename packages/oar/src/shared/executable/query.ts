/** A private child whose kill method stops its process tree and whose exit joins cleanup. */
interface QueryProcess {
  kill(): void;
  readonly exited: Promise<unknown>;
}

export type OwnQueryProcess = <P extends QueryProcess>(process: P) => P;

/**
 * Bound a read from startup through cleanup. Register freshly launched children
 * with own(), even when startup resumes after the deadline. On timeout the
 * caller gets its answer immediately while the process trees finish stopping.
 * An operation promising joined cleanup to its caller, such as logout, owns
 * its process separately.
 */
export async function withQueryDeadline<T>(
  name: string,
  timeoutMs: number,
  query: (signal: AbortSignal, own: OwnQueryProcess) => Promise<T>,
  timeoutResult?: T,
  signal?: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { throw new RangeError("timeoutMs must be positive and finite"); }
  const controller = new AbortController();
  const deadline = Promise.withResolvers<T>();
  const children = new Set<QueryProcess>();
  let closed = false;
  let settledRead: Promise<T> | undefined = undefined;
  const own: OwnQueryProcess = child => {
    if (closed || controller.signal.aborted) { child.kill(); }
    else { children.add(child); }
    return child;
  };
  const stop = (): void => {
    const error = new DOMException(`${name} timed out`, "TimeoutError");
    if (settledRead !== undefined) { deadline.resolve(settledRead); }
    else if (timeoutResult === undefined) { deadline.reject(error); }
    else { deadline.resolve(timeoutResult); }
    controller.abort(error);
  };
  const timer = setTimeout(stop, timeoutMs);
  const work = async (): Promise<T> => {
    try {
      if (signal?.aborted === true) { stop(); return await deadline.promise; }
      signal?.addEventListener("abort", stop, { once: true });
      const reading = query(controller.signal, own);
      try { return await Promise.race([reading, deadline.promise]); }
      finally {
        // A slow shutdown cannot erase an answer the runtime already gave.
        if (!controller.signal.aborted) { settledRead = reading; }
      }
    } finally {
      closed = true;
      const exits: Promise<unknown>[] = [];
      for (const child of children) {
        child.kill();
        exits.push(child.exited);
      }
      await Promise.all(exits);
    }
  };
  try { return await Promise.race([work(), deadline.promise]); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); }
}
