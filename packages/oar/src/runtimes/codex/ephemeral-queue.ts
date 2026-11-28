import type { ControlResult, InputOptions, PromptOptions, RequestRecord, SessionCapabilities } from "../../contracts/session.js";
import { enqueueHeld, withdrawControl, type HeldInput } from "../../shared/held-input.js";
import { inputImagesRefusal } from "../../shared/input-images.js";
import type { SessionKernel } from "../../shared/session-kernel.js";

interface CodexHeldInput extends HeldInput {
  readonly request: RequestRecord;
  readonly input: string;
  readonly options: InputOptions;
  accepted?: true;
}

export interface CodexEphemeralQueue {
  readonly hasHeld: () => boolean;
  readonly queue: (input: string, inputOptions?: InputOptions) => Promise<ControlResult>;
  readonly withdraw: (inputId: string) => Promise<ControlResult>;
  readonly drain: () => void;
  readonly clear: () => void;
}

/**
 * Adapter-held queue for ephemeral Codex threads (`thread/queue/add` rejects
 * ephemeral threads with -32600). Entries drain one at a time via `turn/start`
 * once no turn or manual compaction is active, preserving `carries` and
 * `clientUserMessageId` correlation.
 */
export function createCodexEphemeralQueue(deps: {
  readonly kernel: SessionKernel;
  readonly capabilities: Pick<SessionCapabilities, "images">;
  readonly busy: () => boolean;
  readonly dispatch: (input: string, options: PromptOptions, wireInputId: string | undefined) => Promise<ControlResult>;
}): CodexEphemeralQueue {
  const held: CodexHeldInput[] = [];
  let draining = false;

  function drain(): void {
    if (draining || deps.kernel.unreachable() !== null || deps.busy() || held[0]?.accepted !== true) {
      return;
    }
    const next = held.shift();
    if (next === undefined) {
      return;
    }
    draining = true;
    const { inputId: _inputId, ...rest } = next.options;
    const carries = [next.inputId ?? next.request.id];
    void (async (): Promise<void> => {
      try {
        await deps.dispatch(next.input, { ...rest, carries }, next.inputId);
      } finally {
        draining = false;
        queueMicrotask(drain);
      }
    })();
  }

  return {
    hasHeld: () => held.length > 0,
    queue: async (input, inputOptions) => {
      const result = await deps.kernel.control({ kind: "queue", input, ...inputOptions }, (request) => {
        const imageRefusal = inputImagesRefusal(deps.capabilities, inputOptions?.images);
        if (imageRefusal !== null) {
          return imageRefusal;
        }
        enqueueHeld(held, {
          request,
          input,
          ...(inputOptions?.inputId === undefined ? {} : { inputId: inputOptions.inputId }),
          options: { ...inputOptions },
        });
        return { kind: "accepted", queued: "adapter" };
      });
      const entry = held.find((candidate) => candidate.request.id === result.request.id);
      if (entry !== undefined && result.response.body.kind === "accepted") {
        entry.accepted = true;
      }
      drain();
      return result;
    },
    withdraw: async (inputId) => {
      const result = await withdrawControl(deps.kernel, held)(inputId);
      drain();
      return result;
    },
    drain,
    clear: () => {
      held.splice(0);
    },
  };
}
