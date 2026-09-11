import type { Session, Unsubscribe } from "../contracts/session.js";
import { initialStatus, reduceStatus, stallOf, type AgentStatus } from "./agent-status.js";

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
  /** `kind` of the last folded record, with the event's last view kind when it had one (e.g. `event:tool_call_started`). */
  readonly lastRecordKind: string;
}

export function observeStalls(
  session: Session,
  options: { readonly stallAfterMs: number; readonly onStall: (info: StallInfo) => void },
): Unsubscribe {
  let status: AgentStatus = initialStatus;
  let lastRecordKind = "";
  let timer: NodeJS.Timeout | null = null;

  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = (): void => {
    disarm();
    timer = setTimeout(() => {
      const stall = stallOf(status, Date.now(), options.stallAfterMs);
      if (stall !== null) {
        options.onStall({ ...stall, lastRecordKind });
      }
    }, options.stallAfterMs);
  };

  const unsubscribe = session.subscribe((record) => {
    status = reduceStatus(status, record, session.id);
    const lastView = record.kind === "event" ? record.body.views.at(-1) : undefined;
    lastRecordKind = lastView === undefined ? record.kind : `event:${lastView.kind}`;
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
