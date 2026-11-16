import { observeProcessTiming, type ProcessTiming } from "../../packages/oar/src/shared/executable/process-timing.js";

/** Bounded test-owned retention. Never write logs inside the measured path. */
export default function captureProcessTiming() {
  const events: ProcessTiming[] = [];
  let dropped = 0;
  const openedAtMs = performance.now();
  const unsubscribe = observeProcessTiming(event => {
    if (events.length < 512) { events.push(event); }
    else { dropped += 1; }
  });
  return {
    snapshot: () => ({ clock: "performance.now", openedAtMs, observedThroughMs: performance.now(), dropped, events: [...events] }),
    stop: unsubscribe,
  };
}
