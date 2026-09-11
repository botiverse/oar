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

/**
 * Shared record-stream mechanics every adapter needs: envelope stamping
 * (seq, receivedAt, attribution), the retained log that backs the cursor,
 * synchronous never-awaited observer fan-out with error swallowing, and the
 * session graph. The kernel has NO gate: nothing here decides whether a
 * record may enter the stream — control never prunes facts. The single-
 * active-turn rule is the adapter's control decision and shows up as a
 * rejected prompt response, not as a dropped event. Adapters keep only
 * runtime-specific pumping and control.
 */

/** Where a record sits: another session id for derived children, a sub-agent path, a runtime-native span id. */
export interface RecordAt {
  readonly sessionId?: string;
  readonly agentPath?: readonly string[];
  readonly spanId?: string;
}

export interface SessionKernel {
  readonly sessionId: string;
  /** Append the runtime's frame. Returns the stamped record. */
  event(body: EventBody, at?: RecordAt): EventRecord;
  /** Append a request; `id` defaults to a fresh UUID (runtime-issued ids for `toApp` requests keep their own). */
  request(direction: RequestDirection, body: RequestBody, at?: RecordAt & { readonly id?: string }): RequestRecord;
  /** Append a response pointing at `requestId`. */
  respond(requestId: string, body: ResponseBody, at?: RecordAt): ResponseRecord;
  /** A `toRuntime` control action: record the request, decide, record the response. Exceptions from `decide` become a rejected response carrying the message. */
  control(body: RequestBody, decide: (request: RequestRecord) => ResponseBody | Promise<ResponseBody>, at?: RecordAt): Promise<ControlResult>;
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
    for (const observer of observers) {
      deliver(observer, record);
    }
    return record;
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
      const issued = request("toRuntime", body, at);
      const decided = await settle(decide, issued);
      return { request: issued, response: respond(issued.id, decided, at) };
    },
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
