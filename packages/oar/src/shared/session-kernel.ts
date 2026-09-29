import { randomUUID } from "node:crypto";
import type {
  AppDecision,
  ControlResult,
  Cursor,
  FrameBody,
  Frame,
  RequestBody,
  RequestDirection,
  RequestRecord,
  ResponseBody,
  ResponseRecord,
  SessionEdge,
  SessionGraph,
  RawEventObserver,
  RawEvent,
  Unsubscribe,
} from "../contracts/session.js";
import { askOf, decisionRefusal, type AnswerDelivery, type DeliverAnswer } from "./app-requests.js";

export type { AnswerDelivery, DeliverAnswer } from "./app-requests.js";

/** Where a record sits: another session id for derived children, a sub-agent path, a runtime-native span id. */
export interface RecordAt {
  readonly sessionId?: string;
  readonly agentPath?: readonly string[];
  readonly spanId?: string;
}

/**
 * The one record stream of a session, as every adapter builds it: the
 * implementation of the contract in `contracts/records.ts` and
 * `contracts/session.ts` (semantics: `docs/spec/record-stream.md`,
 * `docs/spec/attribution.md`, `docs/spec/session-graph-and-cursor.md`).
 *
 * What is shared here and never re-implemented per adapter:
 * - the envelope: dense monotonic `seq`, `receivedAt`, and attribution
 *   (`sessionId` / `agentPath` / `spanId`) from `RecordAt`
 *   (attribution.md, "The record envelope");
 * - the retained log behind `records()` and the cursor: `rawEvents()` with
 *   a cursor replays every retained record after `afterSeq`, then continues
 *   live (session-graph-and-cursor.md, "The resumable cursor");
 * - synchronous, never-awaited observer fan-out that swallows observer
 *   errors: observers are a side-tap and can never touch the run;
 * - the session graph of true sessions (`node()` / `link()` / `graph()`;
 *   session-graph-and-cursor.md, "The session graph");
 * - the control shape: `control()` records a `toRuntime` request, lets the
 *   adapter decide, and records the accept/reject response; and the
 *   reachability rule: once the stream holds an `exited` response or a
 *   `dispose` request, control is rejected here without consulting the
 *   adapter (record-stream.md, "Reachability is read off the stream");
 * - the answer shape: `answer()` settles an open `toApp` request with a
 *   host's decision, whether the request is open (not answered, not
 *   withdrawn) and whether its recorded ask takes the decision both read
 *   off the stream (approvals.md); the adapter only sends the reply.
 *
 * What is deliberately NOT here: any gate on facts. Nothing in the kernel
 * decides whether a runtime frame may enter the stream; control never
 * prunes facts (record-stream.md, "The rules"). The single-active-turn rule
 * is the adapter's control decision and shows up as a rejected prompt
 * response, never as a dropped event. Adapters keep only runtime-specific
 * pumping (frame → `frame()`) and control decisions (busy, not_steerable).
 */
export interface SessionKernel {
  readonly sessionId: string;
  /** Append the runtime's frame. Returns the stamped record. */
  frame(body: FrameBody, at?: RecordAt): Frame;
  /** Append a request; `id` defaults to a fresh UUID (runtime-issued ids for `toApp` requests keep their own). */
  request(direction: RequestDirection, body: RequestBody, at?: RecordAt & { readonly id?: string }): RequestRecord;
  /** Append a response pointing at `requestId`. */
  respond(requestId: string, body: ResponseBody, at?: RecordAt): ResponseRecord;
  /**
   * A `toRuntime` control action: record the request, decide, record the
   * response. Exceptions from `decide` become a rejected response carrying the
   * message. When the stream already says the runtime is unreachable (see
   * `unreachable()`), the request is rejected without consulting `decide`.
   */
  control(body: RequestBody, decide: (request: RequestRecord) => ResponseBody | Promise<ResponseBody>, at?: RecordAt): Promise<ControlResult>;
  /**
   * Why a control cannot reach the runtime any more, derived from the stream
   * itself: an `exited` response has been recorded (the runtime is gone) or a
   * `dispose` request has (the session is being released). Null while the
   * runtime is reachable. Adapters that record control outside `control()`
   * apply it themselves; adapter-held liveness flags are not needed.
   */
  unreachable(): { readonly kind: "rejected"; readonly code: "runtime_exited" | "disposed"; readonly reason: string } | null;
  /**
   * `Session.answer`: record an `answer` request for the `toApp` request
   * `requestId`; when the runtime is reachable, the request is open (neither
   * answered nor withdrawn in the stream) and its ask takes `decision`, let
   * `deliver` send the reply, record it as the request's `answered`
   * response (at the request's own envelope), then `accepted`. Anything else
   * is the answer's rejection, and the request stays as it was. Synchronous,
   * so two answers racing for one request cannot both be delivered.
   */
  answer(requestId: string, decision: AppDecision, deliver: DeliverAnswer, at?: RecordAt): ControlResult;
  /** The `toApp` requests still open: neither answered nor withdrawn, in arrival order. Empty once the runtime exited (none can be answered then). */
  openRequests(): readonly RequestRecord[];
  rawEvents(observer: RawEventObserver, cursor?: Cursor): Unsubscribe;
  records(): readonly RawEvent[];
  graph(): SessionGraph;
  /** Add a derived session and the edge that explains it; idempotent per (parent, child, via). */
  link(edge: SessionEdge): void;
  /** Add a session node whose lineage is not (yet) known: an id seen on the wire without an explaining edge. Never fabricate the edge. */
  node(id: string): void;
}

async function settle(
  decide: (request: RequestRecord) => ResponseBody | Promise<ResponseBody>,
  issued: RequestRecord,
): Promise<ResponseBody> {
  try {
    return await decide(issued);
  } catch (error) {
    return { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** An adapter's delivery of an answer; a throw is the answer's `error` rejection. */
function sendAnswer(send: DeliverAnswer, target: RequestRecord, decision: AppDecision): AnswerDelivery {
  try {
    return send(target, decision);
  } catch (error) {
    return { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

function deliver(observer: RawEventObserver, record: RawEvent): void {
  try {
    observer(record);
  } catch {
    // Observers are a side-tap; their failures must not touch the run.
  }
}

export function createSessionKernel(sessionId: string = randomUUID()): SessionKernel {
  const observers = new Set<RawEventObserver>();
  const log: RawEvent[] = [];
  const nodes = new Map<string, { readonly id: string }>([[sessionId, { id: sessionId }]]);
  const edges: SessionEdge[] = [];
  let seq = 0;
  let exited = false;
  let disposing = false;
  // Every toApp request and where the stream says it stands: answered (an
  // `answered` response) or withdrawn (an `app_request_withdrawn` event).
  const toApp = new Map<string, { readonly request: RequestRecord; state: "open" | "answered" | "withdrawn" }>();
  const settleToApp = (record: RawEvent): void => {
    if (record.kind === "request" && record.direction === "toApp") {
      toApp.set(record.id, { request: record, state: "open" });
    } else if (record.kind === "response" && record.body.kind === "answered") {
      const entry = toApp.get(record.requestId);
      if (entry?.state === "open") {
        entry.state = "answered";
      }
    } else if (record.kind === "frame") {
      for (const event of record.body.events) {
        const entry = event.kind === "app_request_withdrawn" ? toApp.get(event.requestId) : undefined;
        if (entry?.state === "open") {
          entry.state = "withdrawn";
        }
      }
    }
  };

  const append = <T extends RawEvent>(build: (envelope: {
    readonly sessionId: string;
    readonly agentPath: readonly string[];
    readonly spanId?: string;
    readonly seq: number;
    readonly receivedAt: number;
  }) => T, at: RecordAt | undefined): T => {
    const spanId = at?.spanId;
    const record = build({
      sessionId: at?.sessionId ?? sessionId,
      agentPath: at?.agentPath ?? [],
      ...(spanId === undefined ? {} : { spanId }),
      seq,
      receivedAt: Date.now(),
    });
    seq += 1;
    log.push(record);
    if (record.kind === "response" && record.body.kind === "exited") {
      exited = true;
    }
    if (record.kind === "request" && record.direction === "toRuntime" && record.body.kind === "dispose") {
      disposing = true;
    }
    settleToApp(record);
    for (const observer of observers) {
      deliver(observer, record);
    }
    return record;
  };

  const unreachable = (): ReturnType<SessionKernel["unreachable"]> => {
    if (exited) {
      return { kind: "rejected", code: "runtime_exited", reason: "runtime exited" };
    }
    return disposing ? { kind: "rejected", code: "disposed", reason: "session disposed" } : null;
  };
  const request: SessionKernel["request"] = (direction, body, at) =>
    append((envelope) => ({ ...envelope, kind: "request", id: at?.id ?? randomUUID(), direction, body }), at);
  const respond: SessionKernel["respond"] = (requestId, body, at) =>
    append((envelope) => ({ ...envelope, kind: "response", requestId, body }), at);

  /** Why the toApp request `requestId` cannot take `decision` now, read off the stream; null when it can. */
  const answerRefusal = (requestId: string, decision: AppDecision): ResponseBody | null => {
    const entry = toApp.get(requestId);
    if (entry === undefined) {
      return { kind: "rejected", code: "unknown_request", reason: `no runtime request ${requestId} in this session` };
    }
    if (entry.state === "answered") {
      return { kind: "rejected", code: "already_answered", reason: `runtime request ${requestId} is already answered` };
    }
    if (entry.state === "withdrawn") {
      return { kind: "rejected", code: "withdrawn", reason: `the runtime withdrew request ${requestId}` };
    }
    const refused = decisionRefusal(askOf(entry.request), decision);
    return refused === null ? null : { kind: "rejected", ...refused };
  };

  return {
    sessionId,
    frame: (body, at) => append((envelope) => ({ ...envelope, kind: "frame", body }), at),
    request,
    respond,
    async control(body, decide, at) {
      const blocked = unreachable();
      const issued = request("toRuntime", body, at);
      const decided = blocked ?? await settle(decide, issued);
      return { request: issued, response: respond(issued.id, decided, at) };
    },
    answer(requestId, decision, send, at) {
      const blocked = unreachable();
      const issued = request("toRuntime", { kind: "answer", requestId, decision }, at);
      const refused = blocked ?? answerRefusal(requestId, decision);
      const target = toApp.get(requestId)?.request;
      if (refused !== null || target === undefined) {
        return { request: issued, response: respond(issued.id, refused ?? { kind: "rejected", code: "unknown_request", reason: requestId }, at) };
      }
      const delivery = sendAnswer(send, target, decision);
      if (delivery.kind === "rejected") {
        return { request: issued, response: respond(issued.id, delivery, at) };
      }
      // The answer to a child agent's (or child session's) request sits where the request does.
      respond(requestId, { kind: "answered", native: delivery.native }, { sessionId: target.sessionId, agentPath: target.agentPath });
      return { request: issued, response: respond(issued.id, { kind: "accepted" }, at) };
    },
    openRequests: () => (exited ? [] : [...toApp.values()].filter((entry) => entry.state === "open").map((entry) => entry.request)),
    unreachable,
    rawEvents(observer, cursor) {
      if (cursor !== undefined) {
        if (cursor.sessionId !== sessionId) {
          throw new Error(`cursor belongs to session ${cursor.sessionId}, not ${sessionId}`);
        }
        for (const record of log) {
          if (record.seq > cursor.afterSeq) {
            deliver(observer, record);
          }
        }
      }
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    records: () => log,
    graph: () => ({ nodes: [...nodes.values()], edges: [...edges] }),
    node(id) {
      if (!nodes.has(id)) {
        nodes.set(id, { id });
      }
    },
    link(edge) {
      if (!nodes.has(edge.parent)) {
        nodes.set(edge.parent, { id: edge.parent });
      }
      if (!nodes.has(edge.child)) {
        nodes.set(edge.child, { id: edge.child });
      }
      if (!edges.some((known) => known.parent === edge.parent && known.child === edge.child)) {
        edges.push(edge);
      }
    },
  };
}
