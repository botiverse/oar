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

function linkFromExtension(kernel: SessionKernel, params: JsonRecord): void {
  const parent = params.parentSessionId;
  const child = typeof params.childSessionId === "string" ? params.childSessionId : params.sessionId;
  if (typeof parent === "string" && typeof child === "string" && parent !== child) {
    kernel.link({ parent, child, via: "tool_call" });
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
        kernel.event({ type: method, native: params, views: [] });
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
