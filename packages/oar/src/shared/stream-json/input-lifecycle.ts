import type { RuntimeEventBody } from "../../contracts/session.js";
import type { LoadedImage } from "../input-images.js";
import type { JsonRecord } from "../json.js";
import type { StreamJsonProjectionState } from "./state.js";

/** Control plane → state: a prompt clears stale abort intent and starts a new native input attempt. */
export function streamJsonPrompted<S extends StreamJsonProjectionState>(state: S, inputId?: string, prompted = true): S {
  return { ...state, abortRequested: false, turnActive: prompted, unclaimedInit: false, promptInputId: inputId ?? null, pendingInputId: null,
    promptInputs: inputId === undefined ? state.promptInputs : new Set([...state.promptInputs, inputId]),
    unstartedInputs: inputId === undefined ? state.unstartedInputs : new Set([...state.unstartedInputs, inputId]),
    unacknowledgedInputs: inputId === undefined ? state.unacknowledgedInputs : new Set([...state.unacknowledgedInputs, inputId]) };
}

/** Keep an unclaimed root init until queued can prove it belongs to a spontaneous turn. */
export function streamJsonInitialized<S extends StreamJsonProjectionState>(state: S, root: boolean): {
  readonly state: S; readonly events: readonly RuntimeEventBody[];
} {
  if (!root) { return { state, events: [] }; }
  const spontaneous = !state.turnActive;
  const unclaimedInit = state.unclaimedInit || (!spontaneous && !state.nativeTurnActive && state.promptInputId !== null && state.unstartedInputs.has(state.promptInputId));
  return { state: { ...state, turnActive: true, nativeTurnActive: true, unclaimedInit },
    events: spontaneous ? [{ kind: "turn_active" }] : [] };
}

function forgetInput<S extends StreamJsonProjectionState>(state: S, inputId: string): S {
  const promptInputs = new Set(state.promptInputs); promptInputs.delete(inputId);
  const unstartedInputs = new Set(state.unstartedInputs); unstartedInputs.delete(inputId);
  const unacknowledgedInputs = new Set(state.unacknowledgedInputs); unacknowledgedInputs.delete(inputId);
  return { ...state, promptInputs, unstartedInputs, unacknowledgedInputs,
    ...(state.promptInputId === inputId ? { promptInputId: null, turnActive: state.nativeTurnActive, unclaimedInit: false } : {}),
    ...(state.pendingInputId === inputId ? { pendingInputId: null } : {}) };
}

/** A replay/completed without queued or started since this write is a duplicate-id refusal in the lifecycle dialect. */
export function streamJsonDuplicateInput<S extends StreamJsonProjectionState>(state: S, inputId: string, root: boolean, duplicateReason: string): {
  readonly state: S; readonly events: readonly RuntimeEventBody[];
} {
  return root && state.promptInputs.has(inputId) && state.unacknowledgedInputs.has(inputId)
    ? { state: forgetInput(state, inputId), events: [{ kind: "input_dropped", inputId, reason: "runtime_refused", failure: "invalid_request",
      message: duplicateReason }] }
    : { state, events: [] };
}

/** Only prompt-like writes own a turn. A steer can be started inside the current turn. */
export function streamJsonInputLifecycle<S extends StreamJsonProjectionState>(state: S, message: JsonRecord, root: boolean, duplicateReason: string): {
  readonly state: S; readonly events: readonly RuntimeEventBody[];
} {
  const inputId = typeof message.command_uuid === "string" ? message.command_uuid : null;
  if (inputId === null || !state.promptInputs.has(inputId) || !root) { return { state, events: [] }; }
  const unacknowledgedInputs = new Set(state.unacknowledgedInputs); unacknowledgedInputs.delete(inputId);
  if (message.state === "queued") {
    // An init can beat this receipt after the host writes. Only now is it
    // known to belong to another turn; preserve the facts in this frame's order.
    const spontaneous = inputId === state.promptInputId && state.unclaimedInit;
    return { events: [{ kind: "input_queued", inputId }, ...(spontaneous ? [{ kind: "turn_active" as const }] : [])], state: { ...state, unacknowledgedInputs,
      ...(inputId === state.promptInputId ? { turnActive: state.nativeTurnActive, unclaimedInit: false, pendingInputId: inputId } : {}) } };
  }
  if (message.state === "started") {
    const unstartedInputs = new Set(state.unstartedInputs); unstartedInputs.delete(inputId);
    return { events: [{ kind: "turn_active", inputId }], state: { ...state, turnActive: true, nativeTurnActive: true, unclaimedInit: false, unstartedInputs, unacknowledgedInputs,
      ...(state.pendingInputId === inputId ? { pendingInputId: null } : {}) } };
  }
  if (message.state === "cancelled") {
    return { events: state.unstartedInputs.has(inputId) ? [{ kind: "input_dropped", inputId, reason: "turn_interrupted" }] : [], state: forgetInput(state, inputId) };
  }
  // completed never ends a turn; without queued/started it confirms an ignored duplicate.
  if (message.state === "completed") {
    const duplicate = streamJsonDuplicateInput(state, inputId, root, duplicateReason);
    return { events: duplicate.events, state: forgetInput(duplicate.state, inputId) };
  }
  return { state, events: [] };
}

/** One stream-json user message; images go before the text, as the Messages API recommends. */
export function streamJsonUserMessage(text: string, inputId?: string, images: readonly LoadedImage[] = []): string {
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
