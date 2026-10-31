import type { RuntimeEventBody } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../json.js";
import type { SessionKernel } from "../session-kernel.js";
import { newSessionLinks } from "../session-links.js";
import { acpReportedEffort, acpReportedModel } from "./model.js";
import { methods, type SessionNotification } from "./process.js";
import { createAcpProjectionState, projectAcpUpdate, type AcpProjectionState } from "./projection.js";
import type { UsageUpdateGate } from "./usage-wait.js";
import type { AcpSessionProfile } from "./profile.js";
import type { AcpTokenUsage } from "./token-usage.js";

/**
 * How ACP wire traffic lands in the record stream. Every frame is recorded
 * verbatim; this module only decides the envelope (which session id) and the
 * events. Every routed update retains its native session id. Shared
 * connections prove ownership before this layer and provide only accepted
 * parent/child links. Isolated profiles retain their existing attribution.
 */
export interface AcpRecorder {
  /**
   * Attach the kernel. The session id is only known after the handshake, so
   * everything recorded before this point is queued in arrival order and
   * appended now (kimi pushes its model config_option_update before
   * session/set_model is answered, i.e. while still opening).
   */
  bind(kernel: SessionKernel): void;
  update(notification: SessionNotification, receivedAt?: number): void;
  /** A vendor extension notification, verbatim; a parent/child session pair links the graph. afterOpen is captured on the wire, before SDK routing or recorder buffering. */
  extension(method: string, params: JsonRecord, afterOpen?: boolean, receivedAt?: number): void;
  /** A handshake answer (initialize, session/new|resume|load, session/set_model, session/set_config_option): the runtime's word, with its model and effort reports as events. */
  step(method: string, response: JsonRecord): void;
  /** A runtime→app request, verbatim, under the runtime's own request id. */
  requested(id: string, method: string, params: unknown, receivedAt?: number): void;
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
 * child_session_id, subagent_type, …}}`: snake_case, nested under `update`;
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

export function createAcpRecorder(usageGate: UsageUpdateGate, attributeUpdate?: AcpSessionProfile["attributeUpdate"], tokenUsage?: AcpTokenUsage, associations?: (method: string, params: JsonRecord) => readonly { readonly parent: string; readonly child: string }[]): AcpRecorder {
  const hostRequests = new Map<string, string>();
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
    update(notification, receivedAt) {
      write((kernel) => {
        const source = attributeUpdate?.(notification);
        const update = asRecord(notification.update);
        const ownedLinks = associations?.(methods.client.session.update, asRecord(notification) ?? {});
        if (source !== null && source !== undefined && ownedLinks !== undefined
          && !ownedLinks.some(link => link.parent === source.parent && link.child === source.sessionId)) {
          // Preserve the carrier's native frame, but rejected metadata cannot
          // relabel it as another owner's child or contaminate root projections.
          // This also covers an unresolved parent. Records are append-only: a
          // later accepted link does not retroactively project this native-only frame.
          kernel.frame({ type: methods.client.session.update, native: notification, events: [] },
            { sessionId: notification.sessionId, ...(receivedAt === undefined ? {} : { receivedAt }) });
          return;
        }
        const sessionId = source?.sessionId ?? notification.sessionId;
        const foreign = sessionId !== kernel.sessionId;
        const events: RuntimeEventBody[] = update === null ? [] : projectAcpUpdate(projectionFor(sessionId), update);
        if (ownedLinks !== undefined) { events.push(...newSessionLinks(kernel, ownedLinks.map(({ parent, child }) => ({ parent, child, via: "tool_call" })))); }
        else if (source?.parent !== undefined) {
          events.push(...newSessionLinks(kernel, [{ parent: source.parent, child: sessionId, via: "tool_call" }]));
        }
        const type = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : methods.client.session.update;
        const record = kernel.frame({ type, native: notification, events }, { ...(foreign ? { sessionId } : {}), ...(receivedAt === undefined ? {} : { receivedAt }) });
        if (!foreign) {
          usageGate.observe(events.some((event) => event.kind === "usage") ? record.seq : undefined);
        }
      });
    },
    extension(method, params, afterOpen, receivedAt) {
      write((kernel) => {
        // The envelope says whose frame this is: a child session pushes its
        // own `response_completed` / `turn_completed` on grok's vendor method
        // with ITS id in `sessionId` (live-grok-c/subagent.voyage.jsonl seqs
        // 78, 119, 120), so it is recorded under the child like a foreign
        // `session/update`. A frame that merely NAMES a child (the parent's
        // `subagent_*` lifecycle) keeps the parent's envelope.
        const sessionId = stringField(params, ["sessionId"]);
        const foreign = sessionId !== null && sessionId !== kernel.sessionId;
        const lineage = acpLineageOf(params);
        const links = associations?.(method, params) ?? (lineage === null ? [] : [lineage]);
        const events: RuntimeEventBody[] = newSessionLinks(kernel, links.map(({ parent, child }) => ({ parent, child, via: "tool_call" })));
        const usage = sessionId === kernel.sessionId ? tokenUsage?.extension(method, params, afterOpen ?? false) : null;
        if (usage !== null && usage !== undefined) { events.push(usage); }
        kernel.frame({ type: method, native: params, events }, { ...(foreign ? { sessionId } : {}), ...(receivedAt === undefined ? {} : { receivedAt }) });
      });
    },
    step(method, response) {
      write((kernel) => {
        const model = acpReportedModel(response);
        const effort = acpReportedEffort(response);
        kernel.frame({ type: method, native: response, events: [
          ...(model === null ? [] : [{ kind: "model" as const, model }]),
          ...(effort === null ? [] : [{ kind: "effort" as const, effort }]),
        ] });
      });
    },
    requested(id, method, params, receivedAt) {
      write((kernel) => {
        const sessionId = asRecord(params)?.sessionId;
        const foreign = typeof sessionId === "string" && sessionId !== kernel.sessionId;
        if (foreign) { hostRequests.set(id, sessionId); }
        kernel.request("toApp", { kind: "native", type: method, native: params }, { id, ...(foreign ? { sessionId } : {}), ...(receivedAt === undefined ? {} : { receivedAt }) });
      });
    },
    answered(id, reply) {
      write((kernel) => {
        const sessionId = hostRequests.get(id);
        hostRequests.delete(id);
        kernel.respond(id, { kind: "answered", native: reply ?? null }, sessionId === undefined ? undefined : { sessionId });
      });
    },
  };
}
