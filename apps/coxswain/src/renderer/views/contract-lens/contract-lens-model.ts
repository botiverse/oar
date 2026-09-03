import type { SessionEventView } from "../../../shared/ipc.js";

/** The v1 stream invariants that can be checked without runtime internals. */
export type ContractInvariant =
  | "turn_end_once"
  | "no_events_after_turn_end"
  | "received_at_monotonic";

export interface ContractAlarm {
  readonly invariant: ContractInvariant;
  readonly laneId?: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly seq: number;
  readonly receivedAt: number;
  readonly eventKind: SessionEventView["kind"];
  readonly message: string;
  /** Present only for the timestamp-order invariant. */
  readonly previousReceivedAt?: number;
}

export interface ContractTurnState {
  readonly sessionId: string;
  readonly turnId: string;
  readonly ended: boolean;
  readonly lastReceivedAt: number;
}

export interface ContractLensState {
  readonly turns: readonly ContractTurnState[];
  readonly alarms: readonly ContractAlarm[];
}

export const initialContractLensState: ContractLensState = {
  turns: [],
  alarms: [],
};

export function invariantLabel(invariant: ContractInvariant): string {
  switch (invariant) {
    case "turn_end_once":
      return "turn ended more than once";
    case "no_events_after_turn_end":
      return "event after turn ended";
    case "received_at_monotonic":
      return "receivedAt moved backwards";
  }
  throw new Error("Unknown contract invariant");
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

function alarm(
  event: SessionEventView,
  invariant: ContractInvariant,
  laneId: string | undefined,
  message: string,
  previousReceivedAt?: number,
): ContractAlarm {
  return {
    invariant,
    ...(laneId === undefined ? {} : { laneId }),
    sessionId: event.sessionId,
    turnId: event.turnId,
    seq: event.seq,
    receivedAt: event.receivedAt,
    eventKind: event.kind,
    message,
    ...(previousReceivedAt === undefined ? {} : { previousReceivedAt }),
  };
}

/**
 * Fold one public SessionEvent into the consumer-side contract lens.
 *
 * The fold deliberately reports only what is knowable at the moment an
 * event arrives. A still-open turn is not an alarm: the stream may simply be
 * in flight. A second terminal event is both a duplicate end and a
 * post-terminal event, so both independent invariant alarms are retained.
 */
export function reduceContractLensEvent(
  state: ContractLensState,
  event: SessionEventView,
  laneId?: string,
): ContractLensState {
  const key = turnKey(event.sessionId, event.turnId);
  const turnIndex = state.turns.findIndex((turn) => turnKey(turn.sessionId, turn.turnId) === key);
  const previous = turnIndex === -1 ? undefined : state.turns[turnIndex];
  const nextAlarms: ContractAlarm[] = [];

  if (previous?.ended === true && event.kind === "turn_ended") {
    nextAlarms.push(alarm(
      event,
      "turn_end_once",
      laneId,
      `turn ${event.turnId.slice(0, 8)} ended more than once`,
    ));
  }
  if (previous?.ended === true) {
    nextAlarms.push(alarm(
      event,
      "no_events_after_turn_end",
      laneId,
      `event ${event.kind} arrived after turn ${event.turnId.slice(0, 8)} ended`,
    ));
  }
  if (previous !== undefined && event.receivedAt < previous.lastReceivedAt) {
    nextAlarms.push(alarm(
      event,
      "received_at_monotonic",
      laneId,
      `receivedAt ${event.receivedAt} is earlier than ${previous.lastReceivedAt}`,
      previous.lastReceivedAt,
    ));
  }

  const nextTurn: ContractTurnState = {
    sessionId: event.sessionId,
    turnId: event.turnId,
    ended: previous?.ended === true || event.kind === "turn_ended",
    lastReceivedAt: event.receivedAt,
  };
  const turns = turnIndex === -1
    ? [...state.turns, nextTurn]
    : state.turns.map((turn, index) => index === turnIndex ? nextTurn : turn);
  return {
    turns,
    alarms: nextAlarms.length === 0 ? state.alarms : [...state.alarms, ...nextAlarms],
  };
}

export function reduceContractLensEvents(
  state: ContractLensState,
  events: readonly SessionEventView[],
  laneId?: string,
): ContractLensState {
  return events.reduce(
    (current, event) => reduceContractLensEvent(current, event, laneId),
    state,
  );
}

/** Replay helper used by Activity and deterministic smoke fixtures. */
export function contractLensForEvents(
  events: readonly SessionEventView[],
  laneId?: string,
): ContractLensState {
  return reduceContractLensEvents(initialContractLensState, events, laneId);
}
