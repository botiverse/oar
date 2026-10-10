import type { RuntimeEventBody } from "../../contracts/session.js";
import type { JsonRecord } from "../../shared/json.js";
import type { ClaudeProjectionState } from "./projection.js";

/** Only prompt-like writes own a turn. A steer can be started inside the current turn. */
export function claudeInputLifecycle(state: ClaudeProjectionState, message: JsonRecord, root: boolean): {
  readonly state: ClaudeProjectionState; readonly events: readonly RuntimeEventBody[];
} {
  const inputId = typeof message.command_uuid === "string" ? message.command_uuid : null;
  if (inputId === null || !state.promptInputs.has(inputId) || !root) { return { state, events: [] }; }
  if (message.state === "queued") {
    return { events: [{ kind: "input_queued", inputId }], state: inputId === state.promptInputId
      ? { ...state, turnActive: false, pendingInputId: inputId } : state };
  }
  if (message.state === "started") {
    return { events: [{ kind: "turn_active", inputId }], state: { ...state, turnActive: true,
      ...(state.pendingInputId === inputId ? { pendingInputId: null } : {}) } };
  }
  // completed never ends a turn. Forget only the registration it confirms.
  if (message.state === "completed") {
    const promptInputs = new Set(state.promptInputs); promptInputs.delete(inputId);
    return { events: [], state: { ...state, promptInputs } };
  }
  return { state, events: [] };
}
