import type { Session, Unsubscribe } from "../contracts/session.js";
import { initialStatus, reduceStatus, stallOf, type AgentStatus } from "./agent-status.js";

/**
 * Convenience layer over the public status reducer: fold the session's events
 * with reduceStatus, ask stallOf with the wall clock, and report when an
 * active turn has been silent for `stallAfterMs`. There is deliberately no
 * second state machine here — the reducer is the single source of truth.
 * Fires once per silence episode; the next event re-arms it. The embedder
 * decides what a stall means (surface, notify, or abort via its turn handle).
 */
export interface StallInfo {
  readonly turnId: string;
  readonly silentForMs: number;
  readonly lastEventKind: string;
}

export function observeStalls(
  session: Session,
  options: { readonly stallAfterMs: number; readonly onStall: (info: StallInfo) => void },
): Unsubscribe {
  let status: AgentStatus = initialStatus;
  let lastEventKind = "";
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
        options.onStall({ ...stall, lastEventKind });
      }
    }, options.stallAfterMs);
  };

  const unsubscribe = session.subscribe((event) => {
    status = reduceStatus(status, event);
    lastEventKind = event.kind;
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
