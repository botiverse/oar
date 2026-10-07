/**
 * Bound interruption independently of its acknowledgement. Repeated aborts
 * cannot postpone the first deadline. An explicit refusal withdraws only
 * that attempt; a turn end or process exit clears every attempt. The process
 * owner supplies its normal SIGTERM/SIGKILL teardown.
 */
export function createAbortFallback(kill: () => void, timeoutMs = 10_000): { arm(onFallback?: () => void): () => void; clear(): void } {
  let timer: NodeJS.Timeout | null = null;
  let triggered = false;
  const attempts = new Map<symbol, (() => void) | undefined>();
  const clear = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    attempts.clear();
    triggered = false;
  };
  return {
    arm(onFallback) {
      if (triggered) { onFallback?.(); return () => {}; }
      const attempt = Symbol("abort");
      attempts.set(attempt, onFallback);
      if (timer === null) {
        timer = setTimeout(() => {
          triggered = true;
          // Recording acceptance can reenter controls and mutate the attempts.
          const takeovers = [...attempts.values()];
          for (const accept of takeovers) { accept?.(); }
          kill();
        }, timeoutMs);
        timer.unref();
      }
      return () => {
        if (attempts.delete(attempt) && attempts.size === 0) { clear(); }
      };
    },
    clear,
  };
}
