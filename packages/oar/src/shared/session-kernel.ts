import { randomUUID } from "node:crypto";
import type {
  ControlResult,
  Cursor,
  EventBody,
  EventRecord,
  RequestBody,
  RequestDirection,
  RequestRecord,
  ResponseBody,
  ResponseRecord,
  SessionEdge,
  SessionGraph,
  SessionObserver,
  SessionRecord,
  Unsubscribe,
} from "../contracts/session.js";

/** Where a record sits: another session id for derived children, a sub-agent path, a runtime-native span id. */
export interface RecordAt {
  readonly sessionId?: string;
  readonly agentPath?: readonly string[];
  readonly spanId?: string;
}

/**
 * The one record stream of a session, as every adapter builds it — the
 * implementation of the contract in `contracts/records.ts` and
 * `contracts/session.ts` (semantics: `docs/spec/record-stream.md`,
 * `docs/spec/attribution.md`, `docs/spec/session-graph-and-cursor.md`).
 *
 * What is shared here and never re-implemented per adapter:
 * - the envelope: dense monotonic `seq`, `receivedAt`, and attribution
 *   (`sessionId` / `agentPath` / `spanId`) from `RecordAt`
 *   (attribution.md, "The record envelope");
 * - the retained log behind `records()` and the cursor: `subscribe()` with
 *   a cursor replays every retained record after `afterSeq`, then continues
 *   live (session-graph-and-cursor.md, "The resumable cursor");
 * - synchronous, never-awaited observer fan-out that swallows observer
 *   errors — observers are a side-tap and can never touch the run;
 * - the session graph of true sessions (`node()` / `link()` / `graph()`;
 *   session-graph-and-cursor.md, "The session graph");
 * - the control shape: `control()` records a `toRuntime` request, lets the
 *   adapter decide, and records the accept/reject response; and the
 *   reachability rule — once the stream holds an `exited` response or a
 *   `dispose` request, control is rejected here without consulting the
 *   adapter (record-stream.md, "Reachability is read off the stream").
 *
 * What is deliberately NOT here: any gate on facts. Nothing in the kernel
 * decides whether a runtime frame may enter the stream — control never
 * prunes facts (record-stream.md, "The rules"). The single-active-turn rule
 * is the adapter's control decision and shows up as a rejected prompt
 * response, never as a dropped event. Adapters keep only runtime-specific
 * pumping (frame → `event()`) and control decisions (busy, not_steerable).
 */
export interface SessionKernel {
  readonly sessionId: string;
  /** Append the runtime's frame. Returns the stamped record. */
  event(body: EventBody, at?: RecordAt): EventRecord;
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
  unreachable(): { readonly kind: "rejected"; readonly reason: string } | null;
  subscribe(observer: SessionObserver, cursor?: Cursor): Unsubscribe;
  records(): readonly SessionRecord[];
  graph(): SessionGraph;
  /** Add a derived session and the edge that explains it; idempotent per (parent, child, via). */
  link(edge: SessionEdge): void;
  /** Add a session node whose lineage is not (yet) known — an id seen on the wire without an explaining edge. Never fabricate the edge. */
  node(id: string): void;
}

async function settle(
  decide: (request: RequestRecord) => ResponseBody | Promise<ResponseBody>,
  issued: RequestRecord,
): Promise<ResponseBody> {
  try {
    return await decide(issued);
  } catch (error) {
    return { kind: "rejected", reason: error instanceof Error ? error.message : String(error) };
  }
}

function deliver(observer: SessionObserver, record: SessionRecord): void {
  try {
    observer(record);
  } catch {
    // Observers are a side-tap; their failures must not touch the run.
  }
}

export function createSessionKernel(sessionId: string = randomUUID()): SessionKernel {
  const observers = new Set<SessionObserver>();
  const log: SessionRecord[] = [];
  const nodes = new Map<string, { readonly id: string }>([[sessionId, { id: sessionId }]]);
  const edges: SessionEdge[] = [];
  let seq = 0;
  let exited = false;
  let disposing = false;

  const append = <T extends SessionRecord>(build: (envelope: {
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
    for (const observer of observers) {
      deliver(observer, record);
    }
    return record;
  };

  const unreachable = (): { readonly kind: "rejected"; readonly reason: string } | null => {
    if (exited) {
      return { kind: "rejected", reason: "runtime exited" };
    }
    return disposing ? { kind: "rejected", reason: "session disposed" } : null;
  };
  const request: SessionKernel["request"] = (direction, body, at) =>
    append((envelope) => ({ ...envelope, kind: "request", id: at?.id ?? randomUUID(), direction, body }), at);
  const respond: SessionKernel["respond"] = (requestId, body, at) =>
    append((envelope) => ({ ...envelope, kind: "response", requestId, body }), at);

  return {
    sessionId,
    event: (body, at) => append((envelope) => ({ ...envelope, kind: "event", body }), at),
    request,
    respond,
    async control(body, decide, at) {
      const blocked = unreachable();
      const issued = request("toRuntime", body, at);
      const decided = blocked ?? await settle(decide, issued);
      return { request: issued, response: respond(issued.id, decided, at) };
    },
    unreachable,
    subscribe(observer, cursor) {
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
      if (!edges.some((known) => known.parent === edge.parent && known.child === edge.child && known.via === edge.via)) {
        edges.push(edge);
      }
    },
  };
}
