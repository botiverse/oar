import type { FrameBody, ResponseBody } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../json.js";
import { streamJsonDuplicateInput, streamJsonInitialized, streamJsonInputLifecycle } from "./input-lifecycle.js";
import { streamJsonContent, streamJsonToolResults, contentBlocks } from "./content.js";
import type { StreamJsonProjectionState } from "./state.js";
import type { StreamJsonProjectionProfile } from "./profile.js";

export type ProjectionCommand =
  | { readonly kind: "frame"; readonly body: FrameBody; readonly agentPath: readonly string[] }
  /** The runtime answered one of our `control_request`s (interrupt): the response to that request record. */
  | { readonly kind: "respond"; readonly requestId: string; readonly body: ResponseBody }
  /** The runtime asked US something (`control_request`): a toApp request record, verbatim. */
  | { readonly kind: "toApp"; readonly id: string; readonly type: string; readonly native: unknown };

/** The agent a frame belongs to: root, or the Task call that spawned it (nested through the call's own agent). */
function attributionOf(state: StreamJsonProjectionState, message: JsonRecord): readonly string[] {
  const parent = message.parent_tool_use_id;
  if (typeof parent !== "string" || parent.length === 0) {
    return [];
  }
  return [...(state.agents.get(parent) ?? []), parent];
}

function rememberToolUses<S extends StreamJsonProjectionState>(state: S, message: JsonRecord, agentPath: readonly string[]): S {
  const event = asRecord(message.event);
  const partial = event?.type === "content_block_start" ? asRecord(event.content_block) : null;
  const ids = (partial === null ? contentBlocks(message) : [partial])
    .filter((block) => block.type === "tool_use" && typeof block.id === "string")
    .map((block) => String(block.id));
  if (ids.length === 0) {
    return state;
  }
  const agents = new Map(state.agents);
  for (const id of ids) {
    agents.set(id, agentPath);
  }
  return { ...state, agents };
}

function frameType(message: JsonRecord): string {
  const type = typeof message.type === "string" ? message.type : "unknown";
  return typeof message.subtype === "string" ? `${type}/${message.subtype}` : type;
}

/** One original frame, ordered projected facts, and control commands. No transport or vendor state. */
export function foldStreamJsonStdout<S extends StreamJsonProjectionState>(
  profile: StreamJsonProjectionProfile<S>,
  state: S,
  message: JsonRecord,
): { readonly state: S; readonly commands: readonly ProjectionCommand[] } {
  const type = frameType(message);
  const agentPath = attributionOf(state, message);
  const event = (body: Omit<FrameBody, "type" | "native">, next: S = state): { state: S; commands: ProjectionCommand[] } =>
    ({ state: next, commands: [{ kind: "frame", body: { type, native: message, ...body }, agentPath }] });

  switch (String(message.type)) {
    case "command_lifecycle": {
      const folded = streamJsonInputLifecycle(state, message, agentPath.length === 0, profile.duplicateReason);
      return event({ events: folded.events }, folded.state);
    }
    case "assistant":
    case "stream_event": {
      const content = streamJsonContent(state.partials, message, agentPath);
      const next = rememberToolUses({ ...state, partials: content.partials }, message, agentPath);
      return event({ events: content.events }, message.type === "assistant" ? profile.assistant(next, message, agentPath.length === 0) : next);
    }
    case "user": {
      const views = [...streamJsonToolResults(message)];
      const body = asRecord(message.message);
      if (message.isReplay === true && typeof message.uuid === "string" && Array.isArray(body?.content)) {
        const input = body.content.map((part: unknown) => asRecord(part)).filter((part) => part?.type === "text").map((part) => typeof part?.text === "string" ? part.text : "").join("");
        views.push({ kind: "user_message", input, inputId: message.uuid, nativeMessageId: message.uuid, evidence: "acknowledged" });
      }
      const duplicate = message.isReplay === true && typeof message.uuid === "string"
        ? streamJsonDuplicateInput(state, message.uuid, agentPath.length === 0, profile.duplicateReason) : { state, events: [] };
      return event({ events: [...views, ...duplicate.events] }, duplicate.state);
    }
    case "result": {
      const result = profile.result(state, message, agentPath);
      return event({ events: [...result.before, { kind: "turn_ended", outcome: result.outcome }, ...result.after] }, {
        ...result.state,
        ...(agentPath.length === 0 ? { turnActive: false, nativeTurnActive: false, unclaimedInit: false, ...(state.pendingInputId === null ? { promptInputId: null } : {}) } : {}),
        abortRequested: false,
      });
    }
    case "system": {
      if (message.subtype === "compact_boundary") {
        // This boundary reports completion, not the start of compaction.
        const trigger = asRecord(message.compact_metadata)?.trigger;
        return event({ events: [{ kind: "compaction_ended", outcome: "completed", ...(typeof trigger === "string" ? { trigger } : {}) }] }, profile.compacted(state, agentPath.length === 0));
      }
      if (message.subtype === "init") {
        const initialized = streamJsonInitialized(state, agentPath.length === 0);
        return event({ events: [...initialized.events,
          ...(typeof message.model === "string" ? [{ kind: "model" as const, model: message.model }] : []),
          ...profile.init(message)] }, initialized.state);
      }
      const next = profile.system(state, message, agentPath);
      return event({ events: next.events }, next.state);
    }
    case "control_response": {
      // The runtime answering one of OUR control_requests (interrupt): the frame IS
      // the response record (native verbatim); one frame, one record, so it
      // is not also recorded as an event. A control_response we cannot pair
      // is recorded as a plain event.
      const response = asRecord(message.response);
      const requestId = typeof response?.request_id === "string" ? response.request_id : null;
      if (requestId === null) {
        return event({ events: [] });
      }
      const error = typeof response?.error === "string" ? response.error : null;
      return { state, commands: [{
        kind: "respond",
        requestId,
        body: response?.subtype === "error" || error !== null
          ? { kind: "rejected", code: "runtime_refused", reason: error ?? "control request failed", native: message }
          : { kind: "accepted", native: message },
      }] };
    }
    case "control_request": {
      // A runtime request is always visible, whether or not the profile supplies a reply.
      const id = typeof message.request_id === "string" ? message.request_id : `${profile.name}-${String(Date.now())}`;
      const request = asRecord(message.request);
      const subtype = typeof request?.subtype === "string" ? request.subtype : "control_request";
      return {
        state,
        commands: [
          { kind: "frame", body: { type, native: message, events: [] }, agentPath },
          { kind: "toApp", id, type: subtype, native: message },
        ],
      };
    }
    case "control_cancel_request":
      // The runtime withdrew a request it had sent us (an interrupt cancels a pending question).
      return event({ events: typeof message.request_id === "string" ? [{ kind: "app_request_cancelled", requestId: message.request_id }] : [] });
    default: {
      const next = profile.other(state, message);
      return event({ events: next.events }, next.state);
    }
  }
}
