import type { Session, Unsubscribe } from "../contracts/session.js";

/**
 * Native answer to "the agent is stuck and nobody knows why": watch a
 * session's event stream and report when an ACTIVE turn has produced no
 * events for `stallAfterMs`. Pure observation over the public side-tap —
 * the embedder decides what to do (surface it, notify, or abort via the turn
 * handle it already holds). Fires once per silence episode; the next event
 * re-arms it. OpenDAL's timeout layer lives at the same altitude: a wrapper
 * over the behavior object, invisible to adapters.
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
  let activeTurnId: string | null = null;
  let lastEventKind = "";
  let lastEventAt = 0;
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
      if (activeTurnId !== null) {
        options.onStall({
          turnId: activeTurnId,
          silentForMs: Date.now() - lastEventAt,
          lastEventKind,
        });
      }
    }, options.stallAfterMs);
  };

  const unsubscribe = session.subscribe((event) => {
    lastEventKind = event.kind;
    lastEventAt = Date.now();
    if (event.kind === "turn_started") {
      activeTurnId = event.turnId;
      arm();
    } else if (event.kind === "turn_ended") {
      activeTurnId = null;
      disarm();
    } else if (activeTurnId !== null) {
      arm();
    }
  });

  return () => {
    disarm();
    unsubscribe();
  };
}
