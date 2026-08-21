import { randomUUID } from "node:crypto";
import type {
  SessionEventBody,
  SessionObserver,
  TurnOutcome,
  Unsubscribe,
} from "../contracts/session.js";

/**
 * Shared session mechanics every adapter needs: envelope stamping (seq,
 * receivedAt), synchronous never-awaited observer fan-out with error
 * swallowing, the single-active-turn gate, and settle-exactly-once turn
 * handles. Adapters keep only runtime-specific pumping and control.
 */
export interface SessionKernel {
  readonly sessionId: string;
  subscribe(observer: SessionObserver): Unsubscribe;
  /** Null while another turn is active — the contract's busy invariant. */
  begin(): KernelTurn | null;
  active(): KernelTurn | null;
}

export interface KernelTurn {
  readonly id: string;
  readonly outcome: Promise<TurnOutcome>;
  settled(): boolean;
  /** Stamps the envelope and fans out; ignored after the turn settled. */
  emit(body: SessionEventBody): void;
  /** Emits turn_ended and resolves the outcome exactly once. */
  settle(outcome: TurnOutcome): void;
}

export function createSessionKernel(): SessionKernel {
  const sessionId = randomUUID();
  const observers = new Set<SessionObserver>();
  let seq = 0;
  let activeTurn: KernelTurn | null = null;

  const fanOut = (turnId: string, body: SessionEventBody): void => {
    const event = {
      sessionId,
      turnId,
      seq,
      receivedAt: Date.now(),
      ...body,
    };
    seq += 1;
    for (const observer of observers) {
      try {
        observer(event);
      } catch {
        // Observers are a side-tap; their failures must not touch the run.
      }
    }
  };

  const begin = (): KernelTurn | null => {
    if (activeTurn !== null && !activeTurn.settled()) {
      return null;
    }
    const id = randomUUID();
    let isSettled = false;
    const { promise: outcome, resolve: resolveOutcome } = Promise.withResolvers<TurnOutcome>();
    const turn: KernelTurn = {
      id,
      outcome,
      settled: () => isSettled,
      emit(body) {
        if (!isSettled) {
          fanOut(id, body);
        }
      },
      settle(result) {
        if (!isSettled) {
          fanOut(id, { kind: "turn_ended", outcome: result });
          isSettled = true;
          resolveOutcome(result);
        }
      },
    };
    activeTurn = turn;
    fanOut(id, { kind: "turn_started" });
    return turn;
  };

  return {
    sessionId,
    subscribe(observer) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    begin,
    active: () => (activeTurn !== null && !activeTurn.settled() ? activeTurn : null),
  };
}
