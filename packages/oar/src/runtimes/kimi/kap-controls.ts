import type {
  AdapterSession,
  InputImage,
  InputOrigin,
  ResponseBody,
  SessionCapabilities,
} from "../../contracts/session.js";
import type { createAbortFallback } from "../../shared/abort-fallback.js";
import { enqueueHeld, withdrawControl, type HeldInput } from "../../shared/held-input.js";
import { inputImagesRefusal, withInputImages } from "../../shared/input-images.js";
import type { JsonRecord } from "../../shared/json.js";
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

export interface KapRuntimeState {
  readonly sessionId: string;
  readonly endpoint: KapEndpoint;
  readonly socket: KapSocket;
  readonly kernel: SessionKernel;
  readonly abortFallback: ReturnType<typeof createAbortFallback>;
  readonly taskAgentById: Map<string, string>;
  readonly held: HeldKapInput[];
  manualCompactionActive: boolean;
  activeRootTurn: string | null;
  rootTurnEpoch: number;
  awaitingTurnStart: boolean;
  prompting: boolean;
  dispatching: boolean;
  steering: number;
  drainScheduled: boolean;
}

export function isKapSessionBusy(state: KapRuntimeState): boolean {
  return (
    state.manualCompactionActive ||
    state.activeRootTurn !== null ||
    state.awaitingTurnStart ||
    state.prompting ||
    state.dispatching
  );
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
  if (!isKapSessionBusy(state) && state.steering === 0 && state.held.length > 0) {
    scheduleDrainHeld(state);
  }
}

export async function drainHeldInput(state: KapRuntimeState): Promise<void> {
  if (state.kernel.unreachable() !== null) { return; }
  if (isKapSessionBusy(state) || state.steering > 0 || state.held[0]?.accepted !== true) { return; }
  const entry = state.held.shift();
  if (entry === undefined) { return; }
  state.dispatching = true;
  const inputId = entry.inputId ?? entry.request.id;
  const request = state.kernel.request("toRuntime", {
    kind: "prompt",
    input: entry.input,
    carries: [inputId],
    ...(entry.images === undefined ? {} : { images: entry.images }),
    ...(entry.origin === undefined ? {} : { origin: entry.origin }),
  });
  const unreachable = state.kernel.unreachable();
  if (unreachable !== null) {
    state.dispatching = false;
    state.kernel.respond(request.id, unreachable);
    return;
  }
  try {
    const turnEpochBefore = state.rootTurnEpoch;
    const delivered = await withInputImages(KAP_SESSION_CAPABILITIES, entry.images, async (loaded) => {
      const data = await kapRequest(state.endpoint.origin, state.endpoint.token, `/sessions/${encodeURIComponent(state.sessionId)}/prompts`, {
        method: "POST",
        body: { prompt_id: inputId, content: buildKapContent(entry.input, loaded) },
        timeoutMs: 30_000,
      });
      if (state.rootTurnEpoch === turnEpochBefore && state.activeRootTurn === null) {
        state.awaitingTurnStart = true;
      }
      return { kind: "accepted", native: data } satisfies ResponseBody;
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
      const result = await state.kernel.control(
        {
          kind: "prompt",
          input,
          ...(promptOptions?.inputId === undefined ? {} : { inputId: promptOptions.inputId }),
          ...(promptOptions?.images === undefined ? {} : { images: promptOptions.images }),
          ...(promptOptions?.origin === undefined ? {} : { origin: promptOptions.origin }),
          ...(promptOptions?.carries === undefined ? {} : { carries: promptOptions.carries }),
        },
        async (req) => {
          if (isKapSessionBusy(state) || state.held.length > 0) {
            return { kind: "rejected", code: "busy", reason: "another turn is active" };
          }
          const delivery = await withInputImages(KAP_SESSION_CAPABILITIES, promptOptions?.images, async (loaded) => {
            const turnEpochBefore = state.rootTurnEpoch;
            state.prompting = true;
            try {
              const promptId = promptOptions?.inputId ?? req.id;
              const data = await kapRequest(
                state.endpoint.origin,
                state.endpoint.token,
                `/sessions/${encodeURIComponent(state.sessionId)}/prompts`,
                {
                  method: "POST",
                  body: { prompt_id: promptId, content: buildKapContent(input, loaded) },
                  timeoutMs: 30_000,
                },
              );
              if (state.rootTurnEpoch === turnEpochBefore && state.activeRootTurn === null) {
                state.awaitingTurnStart = true;
              }
              return { kind: "accepted", native: data };
            } catch (error) {
              return mapPromptControlError(error);
            } finally {
              state.prompting = false;
              maybeScheduleDrain(state);
            }
          });
          return delivery;
        },
      );
      return result;
    },
    steer: async (input, steerOptions) => {
      const result = await state.kernel.control(
        {
          kind: "steer",
          input,
          ...(steerOptions?.inputId === undefined ? {} : { inputId: steerOptions.inputId }),
          ...(steerOptions?.images === undefined ? {} : { images: steerOptions.images }),
          ...(steerOptions?.origin === undefined ? {} : { origin: steerOptions.origin }),
        },
        async (req) => {
          if (state.activeRootTurn === null && !state.awaitingTurnStart && !state.prompting) {
            return { kind: "rejected", code: "no_active_turn", reason: "no active turn to steer" };
          }
          const delivery = await withInputImages(KAP_SESSION_CAPABILITIES, steerOptions?.images, async (loaded) => {
            state.steering += 1;
            try {
              const promptId = steerOptions?.inputId ?? req.id;
              const data = await kapRequest(
                state.endpoint.origin,
                state.endpoint.token,
                `/sessions/${encodeURIComponent(state.sessionId)}/steer`,
                {
                  method: "POST",
                  body: { prompt_id: promptId, content: buildKapContent(input, loaded) },
                  timeoutMs: 30_000,
                },
              );
              return { kind: "accepted", native: data };
            } catch (error) {
              return mapSteerControlError(error);
            } finally {
              state.steering -= 1;
              maybeScheduleDrain(state);
            }
          });
          return delivery;
        },
      );
      return result;
    },
    queue: async (input, queueOptions) => {
      const result = await state.kernel.control(
        {
          kind: "queue",
          input,
          ...(queueOptions?.inputId === undefined ? {} : { inputId: queueOptions.inputId }),
          ...(queueOptions?.images === undefined ? {} : { images: queueOptions.images }),
          ...(queueOptions?.origin === undefined ? {} : { origin: queueOptions.origin }),
        },
        (req) => {
          const invalidImage = inputImagesRefusal(KAP_SESSION_CAPABILITIES, queueOptions?.images);
          if (invalidImage !== null) { return invalidImage; }
          enqueueHeld(state.held, {
            request: req,
            input,
            ...(queueOptions?.inputId === undefined ? {} : { inputId: queueOptions.inputId }),
            ...(queueOptions?.images === undefined ? {} : { images: queueOptions.images }),
            ...(queueOptions?.origin === undefined ? {} : { origin: queueOptions.origin }),
            accepted: false,
          });
          return { kind: "accepted", queued: "adapter" };
        },
      );
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
        if (state.socket.closed()) {
          return { kind: "rejected", code: "runtime_exited", reason: "Kimi KAP WebSocket is closed" };
        }
        try {
          const data: JsonRecord = await state.socket.command({
            type: "task.stop",
            session_id: state.sessionId,
            agent_id: state.taskAgentById.get(taskId) ?? "main",
            task_id: taskId,
          });
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
        if (state.activeRootTurn === null && !state.awaitingTurnStart && !state.prompting) {
          return { kind: "rejected", code: "no_active_turn", reason: "no active turn to abort" };
        }
        const disarm = state.abortFallback.arm();
        try {
          const data = await kapRequest(
            state.endpoint.origin,
            state.endpoint.token,
            `/sessions/${encodeURIComponent(state.sessionId)}:cancel`,
            { method: "POST", body: {}, timeoutMs: 15_000 },
          );
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
