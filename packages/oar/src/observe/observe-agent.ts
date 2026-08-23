import type { Session } from "../contracts/session.js";
import { initialStatus, reduceStatus, stallOf, type AgentStatus } from "./agent-status.js";

/**
 * The composed observer: one subscription yields a unified derived view of
 * the agent — fold state plus the clock overlay. This is the wiring every
 * host was about to hand-roll (subscribe + fold + a ticker): pushed on every
 * event (the fold advances) and on the silence edge (the clock crosses the
 * threshold). The primitives (reduceStatus/stallOf) stay exported for
 * consumers with their own composition needs.
 */

export interface AgentView {
  readonly status: AgentStatus;
  readonly stall: { readonly turnId: string; readonly silentForMs: number } | null;
}

export interface ObserveAgentOptions {
  readonly stallAfterMs: number;
  /** Clock injection for tests; defaults to Date.now. */
  readonly now?: () => number;
  /** Stall-edge poll interval; defaults to 1s. */
  readonly tickMs?: number;
}

export interface AgentObserver {
  /** Push the current view immediately, then on every change; returns unsubscribe. */
  subscribe(listener: (view: AgentView) => void): () => void;
  dispose(): void;
}

export function observeAgent(session: Session, options: ObserveAgentOptions): AgentObserver {
  const now = options.now ?? ((): number => Date.now());
  const listeners = new Set<(view: AgentView) => void>();
  let status: AgentStatus = initialStatus;
  let lastStalled = false;

  const view = (): AgentView => ({ status, stall: stallOf(status, now(), options.stallAfterMs) });
  const push = (): void => {
    const current = view();
    lastStalled = current.stall !== null;
    for (const listener of listeners) {
      try {
        listener(current);
      } catch {
        // observer isolation: one throwing listener never starves the rest
      }
    }
  };

  const unsubscribe = session.subscribe((event) => {
    status = reduceStatus(status, event);
    push();
  });
  const ticker = setInterval(() => {
    // push only on the silence EDGES, not every tick
    const stalledNow = stallOf(status, now(), options.stallAfterMs) !== null;
    if (stalledNow !== lastStalled) {
      push();
    }
  }, options.tickMs ?? 1000);

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(view());
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      clearInterval(ticker);
      unsubscribe();
      listeners.clear();
    },
  };
}

/**
 * The four-word collapse for consumers who want exactly idle/busy/stuck/error.
 * Precedence: stuck beats busy (a silent turn is a problem before it is
 * progress); error means "idle after a failed last turn" — a report about
 * history, never a running state (see the status-bar design notes).
 */
export function simpleStateOf(view: AgentView): "idle" | "busy" | "stuck" | "error" {
  if (view.stall !== null) {
    return "stuck";
  }
  if (view.status.kind === "running") {
    return "busy";
  }
  return view.status.lastTurnOutcome?.kind === "failed" ? "error" : "idle";
}
