import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { ControlResult, InputOptions, PromptOptions, ResponseBody, Session, StartSession } from "../../contracts/session.js";
import type { RuntimeEventBody } from "../../contracts/records.js";
import { withdrawControl } from "../../shared/held-input.js";
import { inputImagesRefusal, withInputImages } from "../../shared/input-images.js";
import { sealSession } from "../../shared/seal-session.js";
import { createSessionKernel } from "../../shared/session-kernel.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { acceptedRecordOf, lastRecordOf, openThread, refusalOf, submitInput } from "./thread.js";
import { createThreadTracker, type ThreadTracker } from "./tracker.js";

/*
 * One OAR session is one Cybion Thread, driven through the Agent API
 * (`/v1/threads`; docs/runtimes/cybion.md):
 *
 * - open: `POST /v1/threads` creates an empty Thread (resume: `GET
 *   /v1/threads/{id}`), so Session.id is the Thread id and a session opened
 *   later with `resume` is the same conversation.
 * - prompt: `POST /v1/threads/{id}/inputs`, then tracker.ts follows the turn.
 * - queue: held here with `queued: "adapter"`; at dispatch it records a prompt
 *   request carrying the held input's identity, as the record-stream spec
 *   requires, so a held input starts a turn like any other and no prompt
 *   overtakes it (`docs/spec/record-stream.md`, adapter-held queue records).
 * - abort: refused. The Agent API has no route that cancels a turn; a Thread
 *   is stopped from Cybion's own UI (`POST /api/threads/{id}/cancel`), which
 *   an API key cannot reach. Nothing here guesses at one.
 * - dispose: the Thread outlives the session by design (it is resumable), so
 *   releasing it records the release and stops nothing on Cybion's side.
 */

/** How long dispose waits for the running turn to end by itself. */
const DISPOSE_SETTLE_MS = 3000;

export const cybionRefusedSessionOptions: RefusedSessionOptions = {
  systemPrompt: "A Cybion Thread takes no per-session system prompt: its instructions are the Manuals Cybion loads for it",
  appendSystemPrompt: "A Cybion Thread takes no per-session system prompt: its instructions are the Manuals Cybion loads for it",
  env: "A Cybion Thread runs on its owner's Workers, not in this process",
  mcpServers: "Cybion's Agent API has no route that attaches an MCP server to a Thread",
  mcpServerCredentials: "Cybion's Agent API has no route that attaches an MCP server to a Thread",
  disallowedTools: "Cybion's Agent API has no per-Thread tool filter",
  launchArgs: "A Cybion Thread is a server-side object; a session launches no process",
  serviceTier: "Cybion's Agent API exposes a boolean fast-tier flag, not a named service tier",
  additionalDirectories: "A Cybion Thread runs on its owner's Workers, so a host directory means nothing to it",
  outputSchema: "Cybion's Agent API has no per-Thread structured output setting",
  userConfiguration: "A Cybion Thread always runs with its owner's configuration, which cannot be excluded",
  goals: "Cybion's Agent API exposes no structured goal controls",
  endTurnProcessesOnAbort: "Cybion's Agent API exposes no turn cancellation at all",
};

interface Held {
  readonly input: string;
  readonly inputId: string;
  readonly images?: InputOptions["images"];
}

/**
 * A session over `client`. The transport is injected so a test drives a
 * scripted deployment without a network.
 */
export function cybionSessionWith(client: Parameters<typeof openThread>[0]): StartSession {
  return async (installation, options) => {
    if (installation.via !== "bundled") {
      throw new Error("The cybion session adapter needs its own bundled installation");
    }
    refuseSessionOptions(cybionRefusedSessionOptions, options);
    const thread = await openThread(client, options);
    const kernel = createSessionKernel(thread.id);
    // The Thread's own report, read at open rather than echoed from the request.
    const opening: RuntimeEventBody[] = [
      ...(thread.model === null ? [] : [{ kind: "model" as const, model: thread.model }]),
      ...(thread.effort === null ? [] : [{ kind: "effort" as const, effort: thread.effort }]),
    ];
    kernel.frame({ type: "thread/opened", native: thread.native, events: opening });

    const held: Held[] = [];
    let disposed = false;
    let draining = false;
    const capabilities = { queue: { durable: false }, attribution: "none", images: true } as const;

    /** Whether the Thread has work of this session's: a running turn, or an input waiting to be sent. */
    const occupied = (): boolean => tracker.busy() || held.length > 0;

    const attempt = async (input: string, images: InputOptions["images"]): Promise<ResponseBody> => {
      const refused = inputImagesRefusal(capabilities, images);
      if (refused !== null) {
        return refused;
      }
      const outcome = await withInputImages(capabilities, images, async (loaded) => {
        try {
          const answer = await submitInput(client, thread.id, input, loaded.map((image) => `data:${image.mediaType};base64,${image.data}`));
          tracker.follow(acceptedRecordOf(answer));
          return { kind: "accepted" as const, native: answer };
        } catch (error) {
          return refusalOf(error);
        }
      });
      return outcome;
    };

    /**
     * Send one held input and record its dispatch as a prompt, so the turn it
     * starts is in the stream like any other. A refusal the Thread reports
     * hands the input back to the caller as `input_dropped`.
     */
    const dispatch = async (entry: Held): Promise<ControlResult> => {
      const result = await kernel.control(
        // The dispatch prompt is its own control identity; the held input it
        // sends is named by `carries` alone (a prompt whose own inputId is the
        // carried one is not a dispatch).
        { kind: "prompt", input: entry.input, carries: [entry.inputId], ...(entry.images === undefined ? {} : { images: entry.images }) },
        async (request): Promise<ResponseBody> => {
          const outcome = await attempt(entry.input, entry.images);
          if (outcome.kind === "rejected") {
            const dropped: RuntimeEventBody = {
              kind: "input_dropped",
              reason: "runtime_refused",
              message: outcome.reason,
              requestId: request.id,
              ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
            };
            kernel.frame({ type: "cybion/send_rejected", native: outcome.native ?? null, events: [dropped] });
          }
          return outcome;
        },
      );
      return result;
    };

    const drain = async (): Promise<void> => {
      if (disposed || draining) {
        return;
      }
      const next = held[0];
      if (next === undefined || tracker.busy()) {
        return;
      }
      draining = true;
      held.shift();
      try {
        const result = await dispatch(next);
        if (result.response.body.kind !== "accepted") {
          // The send failed: the next held input still gets its own turn.
          queueMicrotask(() => {
            void drain();
          });
        }
      } finally {
        draining = false;
      }
    };

    const tracker: ThreadTracker = createThreadTracker({
      client,
      kernel,
      thread,
      // The stream is what this process observes: the Thread's earlier records
      // are not replayed, so a resumed session starts at its own next turn.
      seen: await lastRecordOf(client, thread.id),
      onIdle: () => {
        void drain();
      },
    });

    const session: Session = sealSession({
      id: kernel.sessionId,
      capabilities,
      prompt: async (input: string, inputOptions?: PromptOptions): Promise<ControlResult> => {
        // Busy is the status fold's word as the request is recorded (`control()`
        // records it synchronously), so the contract's invariant holds by
        // construction. A held input also counts: the spec forbids a prompt
        // overtaking input OAR already accepted.
        const busy = occupied();
        const result = await kernel.control({ kind: "prompt", input, ...inputOptions }, async (): Promise<ResponseBody> => {
          if (busy) {
            return { kind: "rejected", code: "busy", reason: "busy" };
          }
          const outcome = await attempt(input, inputOptions?.images);
          return outcome;
        });
        return result;
      },
      queue: async (input: string, inputOptions?: InputOptions): Promise<ControlResult> => {
        // The queue record must name the input it holds: the dispatch prompt that
        // later carries it is checked against this request's `inputId`, so one is
        // made when the caller gave none.
        const inputId = inputOptions?.inputId ?? globalThis.crypto.randomUUID();
        const result = await kernel.control({ kind: "queue", input, ...inputOptions, inputId }, (): ResponseBody => {
          const refused = inputImagesRefusal(capabilities, inputOptions?.images);
          if (refused !== null) {
            return refused;
          }
          held.push({ input, inputId, images: inputOptions?.images });
          return { kind: "accepted", queued: "adapter" };
        });
        void drain();
        return result;
      },
      withdraw: withdrawControl(kernel, held),
      abort: async (): Promise<ControlResult> => {
        const result = await kernel.control({ kind: "abort" }, (): ResponseBody => (
          tracker.busy()
            ? { kind: "rejected", code: "unsupported", reason: "Cybion's Agent API exposes no route that cancels a running turn; stop the Thread from Cybion's own UI" }
            : { kind: "rejected", code: "no_active_turn", reason: "no active turn" }
        ));
        return result;
      },
      rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
      records: () => kernel.records(),
      graph: () => kernel.graph(),
      dispose: async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        const gone = kernel.unreachable() !== null;
        const request = kernel.request("toRuntime", { kind: "dispose" });
        held.length = 0;
        if (!gone && tracker.busy()) {
          // The turn still runs in the Thread; its own status ends it in the stream if it comes in time.
          await tracker.settle(DISPOSE_SETTLE_MS);
        }
        tracker.close();
        kernel.respond(request.id, { kind: "accepted" });
      },
    });
    return session;
  };
}
