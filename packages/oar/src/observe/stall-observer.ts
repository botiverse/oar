import type { Session, Unsubscribe } from "../contracts/session.js";
import { initialStatus, reduceStatus, stallOf } from "./agent-status.js";

/**
 * Convenience layer over the public status reducer: fold the session's records
 * with reduceStatus, ask stallOf with the wall clock, and report when an
 * active turn has been silent for `stallAfterMs`. There is deliberately no
 * second state machine here; the reducer is the single source of truth.
 * Fires once per silence episode; the next record re-arms it. The embedder
 * decides what a stall means (surface, notify, or abort the session).
 */
export interface StallInfo {
  readonly sinceSeq: number;
  readonly silentForMs: number;
  /** `kind` of the last folded record, with the frame's last event kind when it had one (e.g. `frame:tool_call_started`). */
  readonly lastRecordKind: string;
}

export function observeStalls(
  session: Session,
  options: { readonly stallAfterMs: number; readonly onStall: (info: StallInfo) => void },
): Unsubscribe {
  let status = initialStatus;
  let lastRecordKind = "";
  let timer: NodeJS.Timeout | null = null;

  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = (delayMs = options.stallAfterMs): void => {
    disarm();
    timer = setTimeout(() => {
      timer = null;
      const now = Date.now();
      const stall = stallOf(status, now, options.stallAfterMs);
      if (stall !== null) {
        options.onStall({ ...stall, lastRecordKind });
      } else if (status.kind === "running") {
        const remaining = options.stallAfterMs - (now - status.lastEventAt);
        if (Number.isFinite(remaining) && remaining > 0) {
          // A timer can fire before the wall clock reaches the threshold.
          // Keep retries in the timer's range without polling invalid clocks.
          arm(Math.min(2_147_483_647, Math.max(1, remaining)));
        }
      }
    }, delayMs);
  };

  const unsubscribe = session.rawEvents((record) => {
    status = reduceStatus(status, record, session.id);
    const lastEvent = record.kind === "frame" ? record.body.events.at(-1) : undefined;
    lastRecordKind = lastEvent === undefined ? record.kind : `frame:${lastEvent.kind}`;
    if (status.kind === "running") {
      arm();
    } else {
      disarm();
    }
  });

  return () => {
    disarm();
    unsubscribe();
  };
}
