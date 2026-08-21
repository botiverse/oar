import type { SessionEvent, SessionObserver } from "../contracts/session.js";

/**
 * Optional consumer-side aggregation: wrap an observer so consecutive
 * text/thinking deltas arrive as one merged event instead of a token stream.
 * A merged event flushes when the delta kind changes, a non-delta event
 * arrives, or the turn ends; it carries the LAST delta's envelope (seq and
 * receivedAt of the moment the block finished) with the concatenated text.
 * Purely a decorator over the side-tap — adapters and the kernel are unaware.
 */
export function aggregateDeltas(observer: SessionObserver): SessionObserver {
  let held: SessionEvent | null = null;

  const flush = (): void => {
    if (held !== null) {
      const event = held;
      held = null;
      observer(event);
    }
  };

  return (event) => {
    if (event.kind === "text_delta" || event.kind === "thinking_delta") {
      if (held !== null
        && (held.kind === "text_delta" || held.kind === "thinking_delta")
        && held.kind === event.kind && held.turnId === event.turnId) {
        held = { ...event, text: `${held.text}${event.text}` };
        return;
      }
      flush();
      held = event;
      return;
    }
    flush();
    observer(event);
  };
}
