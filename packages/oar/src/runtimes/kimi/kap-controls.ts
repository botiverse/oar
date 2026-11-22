import type {
  AdapterSession,
  InputImage,
  InputOptions,
  InputOrigin,
  ResponseBody,
  SessionCapabilities,
} from "../../contracts/session.js";
import type { createAbortFallback } from "../../shared/abort-fallback.js";
import { enqueueHeld, withdrawControl, type HeldInput } from "../../shared/held-input.js";
import { inputImagesRefusal, withInputImages } from "../../shared/input-images.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import {
  mapAbortControlError,
  mapPromptControlError,
  mapSteerControlError,
  type KapEndpoint,
} from "./kap-errors.js";
import { buildKapContent, KapApiError, kapRequest } from "./kap-protocol.js";
import type { KapSocket } from "./kap-socket.js";

export interface HeldKapInput extends HeldInput {
  readonly request: { readonly id: string; readonly seq: number };
  readonly input: string;
  readonly images?: readonly InputImage[];
  readonly origin?: InputOrigin;
  accepted: boolean;
}

export const KAP_SESSION_CAPABILITIES: SessionCapabilities = {
  queue: { durable: false },
  attribution: "attributed",
  images: true,
};

export interface PendingKapSteer {
  readonly promptId: string;
  parentTurnId: string | null;
}

export interface KapRuntimeState {
  readonly sessionId: string;
  readonly endpoint: KapEndpoint;
  readonly socket: KapSocket;
  readonly kernel: SessionKernel;
  readonly abortFallback: ReturnType<typeof createAbortFallback>;
  readonly taskAgentById: Map<string, string>;
  readonly held: HeldKapInput[];
  readonly pendingSteers: PendingKapSteer[];
  readonly observedRootPromptIds: Set<string>;
  compactionBusy: () => boolean;
  activeRootTurn: string | null;
  rootTurnEpoch: number;
  awaitingTurnStart: boolean;
  abortRequested: boolean;
  prompting: boolean;
  dispatching: boolean;
  drainScheduled: boolean;
}

export function isKapTurnBusy(state: KapRuntimeState): boolean {
  return (
    state.activeRootTurn !== null ||
    state.awaitingTurnStart ||
    state.pendingSteers.length > 0 ||
    state.prompting ||
    state.dispatching
  );
}

export function isKapSessionBusy(state: KapRuntimeState): boolean {
  return state.compactionBusy() || isKapTurnBusy(state);
}

export function scheduleDrainHeld(state: KapRuntimeState): void {
  if (state.drainScheduled) { return; }
  state.drainScheduled = true;
  queueMicrotask(() => {
    state.drainScheduled = false;
    void drainHeldInput(state);
  });
}

function maybeScheduleDrain(state: KapRuntimeState): void {
  if (!isKapSessionBusy(state) && state.held.length > 0) {
    scheduleDrainHeld(state);
  }
}

const WS_CLOSED_REJECTION: ResponseBody = {
  kind: "rejected",
  code: "runtime_exited",
  reason: "Kimi KAP WebSocket is closed",
};

function hasActiveRootTurn(state: KapRuntimeState): boolean {
  return state.activeRootTurn !== null || state.awaitingTurnStart || state.prompting || state.dispatching;
}

function optionalInputFields(opts?: {
  readonly inputId?: string | undefined;
  readonly images?: readonly InputImage[] | undefined;
  readonly origin?: InputOrigin | undefined;
}): Pick<InputOptions, "inputId" | "images" | "origin"> {
  return {
    ...(opts?.inputId === undefined ? {} : { inputId: opts.inputId }),
    ...(opts?.images === undefined ? {} : { images: opts.images }),
    ...(opts?.origin === undefined ? {} : { origin: opts.origin }),
  };
}

function removePendingSteer(list: PendingKapSteer[], target: PendingKapSteer | null): void {
  if (target === null) { return; }
  const idx = list.indexOf(target);
  if (idx !== -1) { list.splice(idx, 1); }
}

async function postKapPrompt(
  state: KapRuntimeState,
  promptId: string,
  content: ReturnType<typeof buildKapContent>,
): Promise<ResponseBody> {
  if (state.socket.closed()) { return WS_CLOSED_REJECTION; }
  const turnEpochBefore = state.rootTurnEpoch;
  const data = await kapRequest(
    state.endpoint.origin,
    state.endpoint.token,
    `/sessions/${encodeURIComponent(state.sessionId)}/prompts`,
    { method: "POST", body: { prompt_id: promptId, content }, timeoutMs: 30_000 },
  );
  if (state.rootTurnEpoch === turnEpochBefore && state.activeRootTurn === null) {
    state.awaitingTurnStart = true;
  }
  return { kind: "accepted", native: data };
}

export async function drainHeldInput(state: KapRuntimeState): Promise<void> {
  if (state.kernel.unreachable() !== null) { return; }
  if (state.socket.closed()) { state.held.length = 0; return; }
  if (isKapSessionBusy(state) || state.held[0]?.accepted !== true) { return; }
  const entry = state.held.shift();
  if (entry === undefined) { return; }
  state.dispatching = true;
  const inputId = entry.inputId ?? entry.request.id;
  const request = state.kernel.request("toRuntime", {
    kind: "prompt",
    input: entry.input,
    carries: [inputId],
    ...optionalInputFields({ images: entry.images, origin: entry.origin }),
  });
  const unreachable = state.kernel.unreachable();
  if (unreachable !== null) {
    state.dispatching = false;
    state.kernel.respond(request.id, unreachable);
    return;
  }
  try {
    const delivered = await withInputImages(KAP_SESSION_CAPABILITIES, entry.images, async (loaded) => {
      const response = await postKapPrompt(state, inputId, buildKapContent(entry.input, loaded));
      return response;
    });
    state.kernel.respond(request.id, state.kernel.unreachable() ?? delivered);
  } catch (error) {
    state.kernel.respond(request.id, state.kernel.unreachable() ?? mapPromptControlError(error));
  } finally {
    state.dispatching = false;
    maybeScheduleDrain(state);
  }
}

export function createKapControls(state: KapRuntimeState): Pick<
  AdapterSession,
  "prompt" | "steer" | "queue" | "withdraw" | "stopTask" | "abort"
> {
  return {
    prompt: async (input, promptOptions) => {
      const body = {
        kind: "prompt" as const,
        input,
        ...optionalInputFields(promptOptions),
        ...(promptOptions?.carries === undefined ? {} : { carries: promptOptions.carries }),
      };
      const result = await state.kernel.control(body, async (req) => {
        if (state.socket.closed()) { return WS_CLOSED_REJECTION; }
        if (isKapSessionBusy(state) || state.held.length > 0) {
          return { kind: "rejected", code: "busy", reason: "another turn is active" };
        }
        state.prompting = true;
        try {
          const delivery = await withInputImages(KAP_SESSION_CAPABILITIES, promptOptions?.images, async (loaded) => {
            try {
              const response = await postKapPrompt(state, promptOptions?.inputId ?? req.id, buildKapContent(input, loaded));
              return response;
            } catch (error) {
              return mapPromptControlError(error);
            }
          });
          return delivery;
        } finally {
          state.prompting = false;
          maybeScheduleDrain(state);
        }
      });
      return result;
    },
    steer: async (input, steerOptions) => {
      const body = { kind: "steer" as const, input, ...optionalInputFields(steerOptions) };
      const result = await state.kernel.control(body, async (req) => {
        if (state.socket.closed()) { return WS_CLOSED_REJECTION; }
        if (!hasActiveRootTurn(state)) {
          return { kind: "rejected", code: "no_active_turn", reason: "no active turn to steer" };
        }
        const promptId = steerOptions?.inputId ?? req.id;
        const pendingSteer: PendingKapSteer | null = state.observedRootPromptIds.has(promptId)
          ? null
          : { promptId, parentTurnId: state.activeRootTurn };
        if (pendingSteer !== null) { state.pendingSteers.push(pendingSteer); }
        const delivery = await withInputImages(KAP_SESSION_CAPABILITIES, steerOptions?.images, async (loaded) => {
          if (state.socket.closed()) {
            removePendingSteer(state.pendingSteers, pendingSteer);
            return WS_CLOSED_REJECTION;
          }
          try {
            const url = `/sessions/${encodeURIComponent(state.sessionId)}/steer`;
            const payload = { prompt_id: promptId, content: buildKapContent(input, loaded) };
            const data = await kapRequest(state.endpoint.origin, state.endpoint.token, url, { method: "POST", body: payload, timeoutMs: 30_000 });
            if (state.observedRootPromptIds.has(promptId)) { removePendingSteer(state.pendingSteers, pendingSteer); }
            return { kind: "accepted", native: data };
          } catch (error) {
            removePendingSteer(state.pendingSteers, pendingSteer);
            return mapSteerControlError(error);
          } finally {
            maybeScheduleDrain(state);
          }
        });
        if (delivery.kind === "rejected") { removePendingSteer(state.pendingSteers, pendingSteer); }
        return delivery;
      });
      return result;
    },
    queue: async (input, queueOptions) => {
      const body = { kind: "queue" as const, input, ...optionalInputFields(queueOptions) };
      const result = await state.kernel.control(body, (req) => {
        if (state.socket.closed()) { return WS_CLOSED_REJECTION; }
        const invalidImage = inputImagesRefusal(KAP_SESSION_CAPABILITIES, queueOptions?.images);
        if (invalidImage !== null) { return invalidImage; }
        enqueueHeld(state.held, { request: req, input, ...optionalInputFields(queueOptions), accepted: false });
        return { kind: "accepted", queued: "adapter" };
      });
      const entry = state.held.find((value) => value.request.id === result.request.id);
      if (entry !== undefined) {
        entry.accepted = true;
        scheduleDrainHeld(state);
      }
      return result;
    },
    withdraw: withdrawControl(state.kernel, state.held),
    stopTask: async (taskId) => {
      const result = await state.kernel.control({ kind: "stop_task", taskId }, async () => {
        if (state.socket.closed()) { return WS_CLOSED_REJECTION; }
        try {
          const agentId = state.taskAgentById.get(taskId) ?? "main";
          const data = await state.socket.command({ type: "task.stop", session_id: state.sessionId, agent_id: agentId, task_id: taskId });
          return { kind: "accepted", native: data };
        } catch (error) {
          if (error instanceof KapApiError) {
            return { kind: "rejected", code: "runtime_refused", reason: error.msg, native: error.envelope };
          }
          return { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) };
        }
      });
      return result;
    },
    abort: async () => {
      const result = await state.kernel.control({ kind: "abort" }, async () => {
        if (state.socket.closed()) { return WS_CLOSED_REJECTION; }
        if (!hasActiveRootTurn(state)) { return { kind: "rejected", code: "no_active_turn", reason: "no active turn to abort" }; }
        const disarm = state.abortFallback.arm();
        try {
          const url = `/sessions/${encodeURIComponent(state.sessionId)}:cancel`;
          const data = await kapRequest(state.endpoint.origin, state.endpoint.token, url, { method: "POST", body: {}, timeoutMs: 15_000 });
          state.abortRequested = true;
          return { kind: "accepted", native: data };
        } catch (error) {
          disarm();
          return mapAbortControlError(error);
        }
      });
      return result;
    },
  };
}
