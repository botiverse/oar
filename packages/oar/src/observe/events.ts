import type {
  ControlAction,
  Event,
  EventObserver,
  RawEvent,
  RawEventObserver,
  RequestBody,
} from "../contracts/session.js";
import { upgradeLegacyBody } from "./legacy.js";

/**
 * A toRuntime request as `eventsOf` reads its response against it (a
 * response names only its `requestId`): the action, which a rejection names,
 * or for a withdraw the request body, whose `inputId` an accepted withdraw
 * names.
 */
export type KnownControl = ControlAction | Extract<RequestBody, { readonly kind: "withdraw" }>;

/** What `eventsOf` keeps of a request body: null for a runtime→app body. */
export function knownControl(body: RequestBody): KnownControl | null {
  if (body.kind === "native") {
    return null;
  }
  return body.kind === "withdraw" ? body : body.kind;
}

/**
 * The consumer face of the stream. `eventsOf` reads the flat, attributed
 * `Event`s out of one record: every reading of a Frame (each stamped with the
 * frame's envelope, so events read from one frame share its `seq`), the turn
 * start a prompt request is, a held input taken back (an accepted withdraw),
 * a rejected control action, a runtime→app request and oar's answer, and the
 * process exit.
 * A record oar read nothing from yields no events. Pure given `actions`, the
 * toRuntime requests seen so far (a response names only its `requestId`;
 * `controlActionsOf` builds the map from a log), so a RawEvent log replays
 * into exactly the events the live subscription delivered.
 */
export function eventsOf(record: RawEvent, actions: ReadonlyMap<string, KnownControl> = new Map()): readonly Event[] {
  const { sessionId, agentPath, seq, receivedAt } = record;
  const envelope = { sessionId, agentPath, seq, receivedAt, ...(record.spanId === undefined ? {} : { spanId: record.spanId }) };
  switch (record.kind) {
    case "frame":
      return record.body.events.map((event): Event => ({ ...upgradeLegacyBody(event), ...envelope }));
    case "request":
      if (record.direction === "toApp") {
        const type = record.body.kind === "native" ? record.body.type : record.body.kind;
        return [{ kind: "app_request", requestId: record.id, type, ...envelope }];
      }
      return record.body.kind === "prompt"
        ? [{
            kind: "turn_started",
            requestId: record.id,
            input: record.body.input,
            ...envelope,
          }]
        : [];
    case "response": {
      if (record.body.kind === "exited") {
        return [{ kind: "exited", code: record.body.code, ...envelope }];
      }
      if (record.body.kind === "answered") {
        return [{ kind: "app_answered", requestId: record.requestId, ...envelope }];
      }
      const known = actions.get(record.requestId);
      if (record.body.kind === "rejected") {
        return known === undefined
          ? []
          : [{ kind: "control_rejected", requestId: record.requestId, action: typeof known === "string" ? known : known.kind, code: record.body.code, reason: record.body.reason, ...envelope }];
      }
      // Accepted: an event of its own only for a withdraw, the input taken back.
      return known === undefined || typeof known === "string"
        ? []
        : [{ kind: "input_withdrawn", requestId: record.requestId, inputId: known.inputId, ...envelope }];
    }
  }
  return [];
}

/** Every toRuntime request in a log as `eventsOf` reads its response, by request id: the `actions` input `eventsOf` needs for rejections and withdrawals. */
export function controlActionsOf(records: readonly RawEvent[]): ReadonlyMap<string, KnownControl> {
  const actions = new Map<string, KnownControl>();
  for (const record of records) {
    remember(actions, record);
  }
  return actions;
}

function remember(actions: Map<string, KnownControl>, record: RawEvent): void {
  if (record.kind === "request" && record.direction === "toRuntime") {
    const known = knownControl(record.body);
    if (known !== null) {
      actions.set(record.id, known);
    }
  }
}

/** A raw-event observer that delivers `eventsOf` each record to `observer`, remembering toRuntime requests so a rejection names its action and an accepted withdraw its input. */
export function eventsReader(observer: EventObserver): RawEventObserver {
  const actions = new Map<string, KnownControl>();
  return (record) => {
    remember(actions, record);
    for (const event of eventsOf(record, actions)) {
      observer(event);
    }
    if (record.kind === "response") {
      actions.delete(record.requestId);
    }
  };
}

function textOf(event: Event): string | null {
  if (event.kind === "text_delta") {
    return event.text;
  }
  return event.kind === "reasoning" && event.content.kind === "text" ? event.content.text : null;
}

function withText(event: Event, text: string): Event {
  if (event.kind === "reasoning") {
    return { ...event, content: { kind: "text", text } };
  }
  return event.kind === "text_delta" ? { ...event, text } : event;
}

function messageIdOf(event: Event): string | undefined {
  return event.kind === "text_delta" || event.kind === "reasoning" ? event.messageId : undefined;
}

function sameLane(held: Event, next: Event): boolean {
  return held.kind === next.kind
    && held.sessionId === next.sessionId
    && held.agentPath.length === next.agentPath.length
    && held.agentPath.every((segment, index) => segment === next.agentPath[index])
    && messageIdOf(held) === messageIdOf(next);
}

/**
 * Consumer-side coalescing: wrap an event observer so consecutive text (or
 * readable reasoning) pieces of one agent arrive as one event instead of a
 * token stream. Flushes when the kind, agent or `messageId` changes, a
 * non-text event arrives, or (when `maxHoldMs` is set) the stream goes quiet
 * for that long.
 * The merged event carries the LAST piece's envelope. Order is safe because
 * only consecutive same-lane pieces are ever held.
 */
export function coalesceText(
  observer: EventObserver,
  options: { readonly maxHoldMs?: number } = {},
): EventObserver {
  let held: Event | null = null;
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
      if (held !== null && previousText !== null && sameLane(held, event)) {
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
