import type { EventRecord, EventView, SessionObserver, SessionRecord } from "../contracts/session.js";

/** The single text-bearing view of a record, when the record carries exactly one view. */
function soleView(record: EventRecord): EventView | null {
  return record.body.views.length === 1 ? (record.body.views[0] ?? null) : null;
}

function textOf(record: EventRecord): string | null {
  const view = soleView(record);
  if (view?.kind === "text_delta") {
    return view.text;
  }
  return view?.kind === "reasoning" && view.content.kind === "text" ? view.content.text : null;
}

function withText(record: EventRecord, text: string): EventRecord {
  const view = soleView(record);
  if (view?.kind === "reasoning") {
    return { ...record, body: { ...record.body, views: [{ kind: "reasoning", content: { kind: "text", text } }] } };
  }
  if (view?.kind === "text_delta") {
    return { ...record, body: { ...record.body, views: [{ kind: "text_delta", text }] } };
  }
  return record;
}

function sameLane(held: EventRecord, next: EventRecord): boolean {
  return soleView(held)?.kind === soleView(next)?.kind
    && held.sessionId === next.sessionId
    && held.agentPath.length === next.agentPath.length
    && held.agentPath.every((segment, index) => segment === next.agentPath[index]);
}

/**
 * Optional consumer-side aggregation: wrap an observer so consecutive
 * text/reasoning deltas of one agent arrive as one merged record instead of a
 * token stream. A merged record flushes when the view kind or agent changes,
 * a non-delta record arrives, or (when `maxHoldMs` is set) the stream goes
 * quiet for that long (a stalled model pause must not hold text hostage;
 * order is safe because only consecutive same-lane deltas are ever held). It
 * carries the LAST delta's envelope and native frame with the concatenated
 * text. Purely a decorator over the side-tap: adapters and the kernel are
 * unaware, and the retained log keeps every original record.
 */
export function aggregateDeltas(
  observer: SessionObserver,
  options: { readonly maxHoldMs?: number } = {},
): SessionObserver {
  let held: EventRecord | null = null;
  let holdTimer: NodeJS.Timeout | null = null;

  const flush = (): void => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (held !== null) {
      const record = held;
      held = null;
      observer(record);
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

  return (record: SessionRecord) => {
    const text = record.kind === "event" ? textOf(record) : null;
    if (record.kind === "event" && text !== null) {
      const previousText = held === null ? null : textOf(held);
      if (held !== null && previousText !== null && sameLane(held, record)) {
        held = withText(record, `${previousText}${text}`);
        armHoldTimer();
        return;
      }
      flush();
      held = record;
      armHoldTimer();
      return;
    }
    flush();
    observer(record);
  };
}
