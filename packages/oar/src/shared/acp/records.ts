import type { EventView } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../json.js";
import type { SessionKernel } from "../session-kernel.js";
import { acpReportedModel } from "./model.js";
import { methods, type SessionNotification } from "./process.js";
import { createAcpProjectionState, projectAcpUpdate, type AcpProjectionState } from "./projection.js";
import type { UsageUpdateGate } from "./usage-wait.js";

/**
 * How ACP wire traffic lands in the record stream. Every frame is recorded
 * verbatim; this module only decides the envelope (which session id) and the
 * views. Nothing is filtered: an update for a session id other than the root
 * is a derived child session — recorded under ITS id and added to the graph
 * (filtering by session id is the adapter red line in
 * docs/spec/runtime-matrix.md).
 */
export interface AcpRecorder {
  /**
   * Attach the kernel. The session id is only known after the handshake, so
   * everything recorded before this point is queued in arrival order and
   * appended now (kimi pushes its model config_option_update before
   * session/set_model is answered, i.e. while still opening).
   */
  bind(kernel: SessionKernel): void;
  update(notification: SessionNotification): void;
  /** A vendor extension notification, verbatim; a parent/child session pair in it links the graph. */
  extension(method: string, params: JsonRecord): void;
  /** A handshake answer (initialize, session/new|resume|load, session/set_model): the runtime's word, with its model report as a view. */
  step(method: string, response: JsonRecord): void;
  /** A runtime→app request, verbatim, under the runtime's own request id. */
  requested(id: string, method: string, params: unknown): void;
  /** oar's answer to a runtime→app request. */
  answered(id: string, reply: unknown): void;
}

function stringField(record: JsonRecord, names: readonly string[]): string | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * The parent/child session pair a vendor notification names, in either
 * spelling and at either depth. grok 1.0.25 (live, 2026-09-11) spells it
 * `_x.ai/session_notification {sessionId: <parent>, update: {sessionUpdate:
 * "subagent_spawned" | "subagent_progress", parent_session_id,
 * child_session_id, subagent_type, …}}` — snake_case, nested under `update`;
 * its `subagent_finished` carries only `child_session_id`, the parent being
 * the envelope's `sessionId`. A flat camelCase `{parentSessionId,
 * childSessionId | sessionId}` is the fixture spelling.
 */
export function acpLineageOf(params: JsonRecord): { readonly parent: string; readonly child: string } | null {
  const envelope = stringField(params, ["sessionId"]);
  // Flat: an explicit parent, the child explicit or the envelope's own id.
  const flatParent = stringField(params, ["parentSessionId", "parent_session_id"]);
  const flatChild = stringField(params, ["childSessionId", "child_session_id"]) ?? envelope;
  if (flatParent !== null && flatChild !== null && flatParent !== flatChild) {
    return { parent: flatParent, child: flatChild };
  }
  // Nested: an explicit child, the parent explicit or the envelope's own id.
  const update = asRecord(params.update);
  const nestedChild = update === null ? null : stringField(update, ["childSessionId", "child_session_id"]);
  const nestedParent = update === null ? null : (stringField(update, ["parentSessionId", "parent_session_id"]) ?? envelope);
  if (nestedParent !== null && nestedChild !== null && nestedParent !== nestedChild) {
    return { parent: nestedParent, child: nestedChild };
  }
  return null;
}

function linkFromExtension(kernel: SessionKernel, params: JsonRecord): void {
  const lineage = acpLineageOf(params);
  if (lineage !== null) {
    kernel.link({ ...lineage, via: "tool_call" });
  }
}

export function createAcpRecorder(usageGate: UsageUpdateGate): AcpRecorder {
  const projections = new Map<string, AcpProjectionState>();
  const projectionFor = (sessionId: string): AcpProjectionState => {
    let state = projections.get(sessionId);
    if (state === undefined) {
      state = createAcpProjectionState();
      projections.set(sessionId, state);
    }
    return state;
  };
  let bound: SessionKernel | null = null;
  const queued: ((kernel: SessionKernel) => void)[] = [];
  const write = (append: (kernel: SessionKernel) => void): void => {
    if (bound === null) {
      queued.push(append);
    } else {
      append(bound);
    }
  };
  return {
    bind(kernel) {
      bound = kernel;
      for (const append of queued.splice(0)) {
        append(kernel);
      }
    },
    update(notification) {
      write((kernel) => {
        const update = asRecord(notification.update);
        const { sessionId } = notification;
        const foreign = sessionId !== kernel.sessionId;
        if (foreign) {
          kernel.node(sessionId);
        }
        const views: EventView[] = update === null ? [] : projectAcpUpdate(projectionFor(sessionId), update);
        const type = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : methods.client.session.update;
        const record = kernel.event({ type, native: notification, views }, foreign ? { sessionId } : undefined);
        if (!foreign) {
          usageGate.observe(views.some((view) => view.kind === "usage") ? record.seq : undefined);
        }
      });
    },
    extension(method, params) {
      write((kernel) => {
        // The envelope says whose frame this is: a child session pushes its
        // own `response_completed` / `turn_completed` on grok's vendor method
        // with ITS id in `sessionId` (live-grok-c/subagent.voyage.jsonl seqs
        // 78, 119, 120), so it is recorded under the child like a foreign
        // `session/update`. A frame that merely NAMES a child (the parent's
        // `subagent_*` lifecycle) keeps the parent's envelope.
        const sessionId = stringField(params, ["sessionId"]);
        const foreign = sessionId !== null && sessionId !== kernel.sessionId;
        if (foreign) {
          kernel.node(sessionId);
        }
        kernel.event({ type: method, native: params, views: [] }, foreign ? { sessionId } : undefined);
        linkFromExtension(kernel, params);
      });
    },
    step(method, response) {
      write((kernel) => {
        const model = acpReportedModel(response);
        kernel.event({ type: method, native: response, views: model === null ? [] : [{ kind: "model", model }] });
      });
    },
    requested(id, method, params) {
      write((kernel) => {
        kernel.request("toApp", { kind: "native", type: method, native: params }, { id });
      });
    },
    answered(id, reply) {
      write((kernel) => {
        kernel.respond(id, { kind: "answered", native: reply ?? null });
      });
    },
  };
}
