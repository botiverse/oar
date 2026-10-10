import type { RuntimeEventBody } from "../../contracts/session.js";
import type { LoadedImage } from "../../shared/input-images.js";
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
    const unstartedInputs = new Set(state.unstartedInputs); unstartedInputs.delete(inputId);
    return { events: [{ kind: "turn_active", inputId }], state: { ...state, turnActive: true, nativeTurnActive: true, unstartedInputs,
      ...(state.pendingInputId === inputId ? { pendingInputId: null } : {}) } };
  }
  if (message.state === "cancelled") {
    const promptInputs = new Set(state.promptInputs); promptInputs.delete(inputId);
    const unstartedInputs = new Set(state.unstartedInputs); unstartedInputs.delete(inputId);
    return { events: state.unstartedInputs.has(inputId) ? [{ kind: "input_dropped", inputId, reason: "turn_interrupted" }] : [], state: { ...state, promptInputs, unstartedInputs,
      ...(state.promptInputId === inputId ? { promptInputId: null, turnActive: state.nativeTurnActive } : {}),
      ...(state.pendingInputId === inputId ? { pendingInputId: null } : {}) } };
  }
  // completed never ends a turn. Forget only the registration it confirms.
  if (message.state === "completed") {
    const promptInputs = new Set(state.promptInputs); promptInputs.delete(inputId);
    const unstartedInputs = new Set(state.unstartedInputs); unstartedInputs.delete(inputId);
    return { events: [], state: { ...state, promptInputs, unstartedInputs } };
  }
  return { state, events: [] };
}

/** One stream-json user message; images go before the text, as the Messages API recommends. */
export function claudeUserMessage(text: string, inputId?: string, images: readonly LoadedImage[] = []): string {
  return `${JSON.stringify({
    type: "user",
    ...(inputId === undefined ? {} : { uuid: inputId }),
    message: {
      role: "user",
      content: [
        ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
        ...(text === "" ? [] : [{ type: "text", text }]),
      ],
    },
  })}\n`;
}
