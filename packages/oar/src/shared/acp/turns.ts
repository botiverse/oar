import type {
  InputImage,
  RuntimeEventBody,
  RequestRecord,
  ResponseBody,
  SessionCapabilities,
  TokenTotals,
  TurnOutcome,
} from "../../contracts/session.js";
import { pathToFileURL } from "node:url";
import { withdrawHeld } from "../held-input.js";
import { withInputImages, type LoadedImage } from "../input-images.js";
import { asRecord, type JsonRecord } from "../json.js";
import type { SessionKernel } from "../session-kernel.js";
import { AcpError, acpProcessExitedError } from "./errors.js";
import { promptAcp, type AcpSessionProfile, type UsageUpdateGate } from "./profile.js";
import { methods, type AcpProcess } from "./process.js";
import {
  acpErrorNative,
  acpFailureOutcome,
  acpPromptUsage,
  defaultAcpPromptOutcome,
} from "./projection.js";

/**
 * The turn machinery: ≤1 active turn, each `session/prompt` RPC of it, the
 * host-held queue, cancel with a kill fallback. The RPC ANSWER is the
 * runtime's own turn end and is recorded as an event with a turn_ended event;
 * a rejected RPC is likewise the runtime's word (a prompt-error event). The
 * process dying is not; that is the `exited` response the session records
 * from its exit observer. One turn may span several prompt RPCs (grok's
 * send-now steer): each answer is its own event; the turn_ended event rides
 * the answer that closes the turn, carrying the LATEST request's outcome.
 */
export interface ActiveTurn {
  /** The prompt request that opened this turn; null for a spontaneous (queue-drained) turn. */
  readonly request: RequestRecord | null;
  /** The last record before this turn: what the runtime said during it comes after. */
  readonly since: number;
  readonly outcomes: Map<number, TurnOutcome>;
  readonly pending: Set<number>;
  abortRequested: boolean;
  latestRequest: number;
  fallback: NodeJS.Timeout | null;
}

/** The agent advertised image prompts in `initialize` (`agentCapabilities.promptCapabilities.image`). */
export function acpTakesImages(initialized: JsonRecord): boolean {
  return asRecord(asRecord(initialized.agentCapabilities)?.promptCapabilities)?.image === true;
}

/** One input as ACP ContentBlocks: the images (each naming its file as `uri`), then any nonempty text. */
function acpPrompt(input: string, images: readonly LoadedImage[]): JsonRecord[] {
  return [
    ...images.map((image) => ({ type: "image", mimeType: image.mediaType, data: image.data, uri: pathToFileURL(image.path).href })),
    ...(input === "" ? [] : [{ type: "text", text: input }]),
  ];
}

export interface AcpTurns {
  active(): ActiveTurn | null;
  /** Open a turn with one prompt RPC; rejected when the process is gone or its images can't go (`inputImagesRefusal`). */
  begin(request: RequestRecord | null, input: string, images?: readonly InputImage[]): ResponseBody;
  /** Another prompt RPC inside the active turn (the profile's steer params); rejected like `begin`. */
  steer(state: ActiveTurn, input: string, images: readonly InputImage[] | undefined, extraParams: JsonRecord): Promise<ResponseBody>;
  /** session/cancel, then a bounded wait after which the process is killed. */
  abort(state: ActiveTurn): Promise<ResponseBody>;
  /** Hold input for the next turn, drained when the active one closes; rejected like `begin`. */
  hold(input: string, images: readonly InputImage[] | undefined, inputId: string | undefined): Promise<ResponseBody>;
  /** Take a held input back by its `inputId` before the drain sends it (`withdrawHeld`). */
  withdraw(inputId: string): ResponseBody;
  /** The process is gone: close the active turn (its end is the exited response) and drop held input. */
  onExit(): void;
}

export function createAcpTurns(deps: {
  readonly kernel: SessionKernel;
  readonly runtime: AcpProcess;
  readonly profile: AcpSessionProfile;
  readonly usageGate: UsageUpdateGate;
  readonly capabilities: Pick<SessionCapabilities, "images">;
}): AcpTurns {
  const { kernel, runtime, profile, usageGate, capabilities } = deps;
  const rootId = kernel.sessionId;
  const held: { readonly inputId: string | undefined; readonly prompt: JsonRecord[] }[] = [];
  let active: ActiveTurn | null = null;
  let nextRequest = 0;
  // Running session total of the per-prompt ledgers (profile.promptTokenUsage).
  let billed: TokenTotals = { input: 0, output: 0 };

  const closeTurn = (state: ActiveTurn): void => {
    if (state.fallback !== null) {
      clearTimeout(state.fallback);
      state.fallback = null;
    }
    if (active === state) {
      active = null;
    }
    queueMicrotask(drainHeld);
  };
  const finishRequest = (
    state: ActiveTurn,
    requestNumber: number,
    frame: { readonly type: string; readonly native: unknown; readonly context: RuntimeEventBody | null },
    outcome: TurnOutcome,
  ): void => {
    state.pending.delete(requestNumber);
    state.outcomes.set(requestNumber, outcome);
    const closes = state.pending.size === 0;
    const events: RuntimeEventBody[] = [];
    if (closes) {
      events.push({ kind: "turn_ended", outcome: state.outcomes.get(state.latestRequest) ?? outcome });
    }
    if (frame.context !== null) {
      events.push(frame.context);
    }
    kernel.frame({ type: frame.type, native: frame.native, events });
    if (closes) {
      closeTurn(state);
    }
  };
  const startVendorPrompt = (state: ActiveTurn, prompt: readonly JsonRecord[], extraParams: JsonRecord = {}): void => {
    nextRequest += 1;
    const requestNumber = nextRequest;
    state.latestRequest = requestNumber;
    state.pending.add(requestNumber);
    void (async (): Promise<void> => {
      try {
        usageGate.arm();
        const result = await promptAcp(runtime, rootId, prompt, extraParams);
        // Deliberate ordering: the answer's event waits (bounded) for the
        // usage_update kimi pushes AFTER answering, so the usage record
        // precedes the turn end and contextUsage() at turn_ended is this
        // turn's own value.
        await usageGate.settleAfterPrompt(profile, state.abortRequested);
        const usage = acpPromptUsage(profile.promptContextUsage?.(result) ?? null, profile.promptTokenUsage?.(result) ?? null, billed);
        ({ billed } = usage);
        finishRequest(state, requestNumber, {
          type: methods.agent.session.prompt,
          native: result,
          context: usage.event,
        }, profile.promptOutcome?.(result) ?? defaultAcpPromptOutcome(result));
      } catch (error) {
        if (error instanceof AcpError && error.kind === "process_exited") {
          // Not the runtime's word: the exit observer records the `exited`
          // response, which is the turn's end.
          state.pending.delete(requestNumber);
          closeTurn(state);
          return;
        }
        const turnFrames = kernel.records().flatMap((record) => (record.kind === "frame" && record.seq > state.since ? [record.body] : []));
        const outcome = state.abortRequested ? { kind: "aborted" as const } : acpFailureOutcome(error, turnFrames, profile.failureOutcome);
        finishRequest(state, requestNumber, {
          type: `${methods.agent.session.prompt}/error`,
          native: acpErrorNative(error),
          context: null,
        }, outcome);
      }
    })();
  };
  const gone = (): ResponseBody => ({ kind: "rejected", code: "runtime_exited", reason: acpProcessExitedError(runtime.exitCode).message });
  const open = (request: RequestRecord | null, prompt: readonly JsonRecord[]): ResponseBody => {
    if (runtime.closed) {
      return gone();
    }
    const state: ActiveTurn = {
      request,
      since: kernel.records().at(-1)?.seq ?? -1,
      outcomes: new Map(),
      pending: new Set(),
      abortRequested: false,
      latestRequest: 0,
      fallback: null,
    };
    active = state;
    startVendorPrompt(state, prompt);
    return { kind: "accepted" };
  };
  const begin = (request: RequestRecord | null, input: string, images?: readonly InputImage[]): ResponseBody =>
    withInputImages(capabilities, images, (loaded) => open(request, acpPrompt(input, loaded)));
  function drainHeld(): void {
    // Held input is dropped once the stream says the runtime is unreachable
    // (an `exited` response or a `dispose` request), not by an adapter flag.
    if (kernel.unreachable() !== null || active !== null || runtime.closed) {
      return;
    }
    // Taken off `held` in the same step it is sent: a withdraw after this finds it gone.
    const next = held.shift();
    if (next !== undefined) {
      open(null, next.prompt);
    }
  }

  return {
    active: () => active,
    begin,
    async steer(state, input, images, extraParams) {
      await runtime.spawned;
      if (runtime.closed) {
        return gone();
      }
      return withInputImages(capabilities, images, (loaded) => {
        startVendorPrompt(state, acpPrompt(input, loaded), extraParams);
        return { kind: "accepted" };
      });
    },
    async abort(state) {
      if (!state.abortRequested) {
        state.abortRequested = true;
        try {
          await runtime.connection.agent.notify(methods.agent.session.cancel, { sessionId: rootId });
        } catch (error) {
          return { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) };
        }
        // A runtime that never answers the cancelled prompt is killed; the
        // exit then shows up as the `exited` response, the turn's end.
        state.fallback = setTimeout(() => {
          if (active === state) {
            runtime.kill();
          }
        }, profile.abortTimeoutMs ?? 10_000);
        state.fallback.unref();
      }
      return { kind: "accepted" };
    },
    async hold(input, images, inputId) {
      await runtime.spawned;
      if (runtime.closed) {
        return gone();
      }
      return withInputImages(capabilities, images, (loaded) => {
        held.push({ inputId, prompt: acpPrompt(input, loaded) });
        queueMicrotask(drainHeld);
        return { kind: "accepted" };
      });
    },
    withdraw: (inputId) => withdrawHeld(held, inputId),
    onExit() {
      if (active !== null) {
        closeTurn(active);
      }
      held.splice(0);
    },
  };
}
