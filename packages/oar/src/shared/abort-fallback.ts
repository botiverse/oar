/**
 * Bound interruption independently of its acknowledgement. Repeated aborts
 * cannot postpone the first deadline. An explicit refusal withdraws only
 * that attempt; a turn end or process exit clears every attempt. The process
 * owner supplies its normal SIGTERM/SIGKILL teardown.
 */
export function createAbortFallback(kill: () => void, timeoutMs = 10_000): { arm(): () => void; clear(): void } {
  let timer: NodeJS.Timeout | null = null;
  const attempts = new Set<symbol>();
  const clear = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    attempts.clear();
  };
  return {
    arm() {
      const attempt = Symbol("abort");
      attempts.add(attempt);
      if (timer === null) {
        timer = setTimeout(kill, timeoutMs);
        timer.unref();
      }
      return () => {
        if (attempts.delete(attempt) && attempts.size === 0) { clear(); }
      };
    },
    clear,
  };
}
