import type { SessionEvent, SessionObserver } from "../contracts/session.js";

/**
 * Optional consumer-side aggregation: wrap an observer so consecutive
 * text/thinking deltas arrive as one merged event instead of a token stream.
 * A merged event flushes when the delta kind changes, a non-delta event
 * arrives, the turn ends, or — when `maxHoldMs` is set — the stream goes
 * quiet for that long (a stalled model pause must not hold text hostage;
 * order is safe because only consecutive same-kind deltas are ever held).
 * It carries the LAST delta's envelope with the concatenated text. Purely a
 * decorator over the side-tap — adapters and the kernel are unaware.
 */
export function aggregateDeltas(
  observer: SessionObserver,
  options: { readonly maxHoldMs?: number } = {},
): SessionObserver {
  let held: SessionEvent | null = null;
  let holdTimer: NodeJS.Timeout | null = null;

  const flush = (): void => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (held !== null) {
      const event = held;
      held = null;
      observer(event);
    }
  };

  const armHoldTimer = (): void => {
    if (options.maxHoldMs === undefined) {
      return;
    }
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
    }
    holdTimer = setTimeout(flush, options.maxHoldMs);
  };

  return (event) => {
    if (event.kind === "text_delta" || event.kind === "thinking_delta") {
      if (held !== null
        && (held.kind === "text_delta" || held.kind === "thinking_delta")
        && held.kind === event.kind && held.turnId === event.turnId) {
        held = { ...event, text: `${held.text}${event.text}` };
        armHoldTimer();
        return;
      }
      flush();
      held = event;
      armHoldTimer();
      return;
    }
    flush();
    observer(event);
  };
}
