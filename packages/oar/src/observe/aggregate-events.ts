import type { SessionEvent, SessionObserver } from "../contracts/session.js";

function textOf(event: SessionEvent): string | null {
  if (event.kind === "text_delta") {
    return event.text;
  }
  return event.kind === "reasoning" && event.content.kind === "text"
    ? event.content.text
    : null;
}

function withText(event: SessionEvent, text: string): SessionEvent {
  if (event.kind === "reasoning") {
    return { ...event, content: { kind: "text", text } };
  }
  if (event.kind === "text_delta") {
    return { ...event, text };
  }
  return event;
}

/**
 * Optional consumer-side aggregation: wrap an observer so consecutive
 * text/reasoning chunks arrive as one merged event instead of a token stream.
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
    const text = textOf(event);
    if (text !== null) {
      const previousText = held === null ? null : textOf(held);
      if (held !== null && previousText !== null
        && held.kind === event.kind && held.turnId === event.turnId) {
        held = withText(event, `${previousText}${text}`);
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
