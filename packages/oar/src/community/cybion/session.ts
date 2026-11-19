import type { ControlResult, InputOptions, PromptOptions, ResponseBody, Session, StartSession } from "../../contracts/session.js";
import type { RuntimeEventBody } from "../../contracts/records.js";
import { withdrawControl } from "../../shared/held-input.js";
import { inputImagesRefusal, withInputImages } from "../../shared/input-images.js";
import { sealSession } from "../../shared/seal-session.js";
import { createSessionKernel } from "../../shared/session-kernel.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { cybionRefusedSessionOptions } from "./refused-options.js";
import { acceptedRecordOf, answeredStatusOf, cancelThread, lastRecordOf, openThread, refusalOf, submitInput } from "./thread.js";
import { createThreadTracker, type ThreadTracker } from "./tracker.js";

/*
 * One OAR session is one Cybion Thread, driven through the Agent API
 * (`/v1/threads`; docs/runtimes/cybion.md):
 *
 * - open: `POST /v1/threads` creates an empty Thread (resume: `GET
 *   /v1/threads/{id}`), so Session.id is the Thread id and a session opened
 *   later with `resume` is the same conversation.
 * - prompt: `POST /v1/threads/{id}/inputs`, then tracker.ts follows the turn.
 * - steer: the same route while the turn runs. Cybion cancels what is in flight
 *   (a tool call, an inference request) and keeps the Thread `running` with the
 *   input appended to the same turn, so that turn still ends once — no
 *   `follow()` here, or the turn would be replaced instead of continued.
 * - queue: held here with `queued: "adapter"`; at dispatch it records a prompt
 *   request carrying the held input's identity, as the record-stream spec
 *   requires, so a held input starts a turn like any other and no prompt
 *   overtakes it (`docs/spec/record-stream.md`, adapter-held queue records).
 * - abort: `POST /api/threads/{id}/cancel`, the route Cybion's own UI uses: an
 *   API key authenticates on that router too, and Cybion answers the stopped
 *   Thread. The turn then ends through the Thread's `stopped` status, and an
 *   answer that is not `stopped` is read as a turn that had already ended.
 * - dispose: the Thread outlives the session by design (it is resumable), so
 *   releasing it records the release and stops nothing on Cybion's side.
 */

/** How long dispose waits for the running turn to end by itself. */
const DISPOSE_SETTLE_MS = 3000;

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

    /** Whether the Thread has work of this session's: a running turn, or input waiting to be sent. */
    const occupied = (): boolean => tracker.busy() || held.length > 0;

    /**
     * Hand one input to the Thread. A prompt starts the turn this session
     * follows; a steer must leave the following alone, because Cybion appends
     * its input to the running turn and that turn has to end once (`steer`).
     */
    const send = async (input: string, images: InputOptions["images"], startsTurn: boolean): Promise<ResponseBody> => {
      const refused = inputImagesRefusal(capabilities, images);
      if (refused !== null) {
        return refused;
      }
      const outcome = await withInputImages(capabilities, images, async (loaded) => {
        try {
          const answer = await submitInput(client, thread.id, input, loaded.map((image) => `data:${image.mediaType};base64,${image.data}`));
          if (startsTurn) {
            tracker.follow(acceptedRecordOf(answer));
          }
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
          const outcome = await send(entry.input, entry.images, true);
          // Only an answer from Cybion hands a held input back: a write that never
          // reached it, or an image refused before sending, is not the runtime
          // dropping an input it accepted.
          if (outcome.kind === "rejected" && outcome.native !== undefined) {
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

    /**
     * Record the turn a steer started when it missed the turn it aimed at. Cybion
     * already holds the input, so nothing is sent: what the stream needs is the
     * request record of the turn it started, the way an adapter-held input is
     * dispatched (`dispatch` above), so that turn has its own `turn_started`.
     *
     * This runs a `prompt` control from inside the `steer` control's handler: the
     * kernel allows a control to open another one, and this relies on it. A kernel
     * that serialised controls would deadlock here, so keep the two in one step
     * (or record the prompt before the write) if that ever changes.
     */
    const adoptSteer = async (input: string, images: InputOptions["images"], recordIdx: number | null): Promise<void> => {
      await kernel.control({ kind: "prompt", input, ...(images === undefined ? {} : { images }) }, (): ResponseBody => {
        tracker.follow(recordIdx);
        return { kind: "accepted" };
      });
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
      onGivenUp: () => {
        // No poll follows a given-up turn, so a held input would wait behind a
        // turn that ended: hand each one back to the host instead.
        for (const entry of held.splice(0)) {
          kernel.frame({ type: "cybion/held_dropped", native: null, events: [{ kind: "input_dropped", reason: "turn_interrupted", inputId: entry.inputId }] });
        }
      },
    });

    const session: Session = sealSession({
      id: kernel.sessionId,
      capabilities,
      prompt: async (input: string, inputOptions?: PromptOptions): Promise<ControlResult> => {
        // Busy is read before the request is recorded, and every source of work
        // counts: the status fold (a prompt already accepted), a turn the tracker
        // follows, input held for a later turn, and a dispatch whose POST is in
        // flight. The tracker alone is not enough — it only knows a turn after
        // `/inputs` answers — so two prompts in one tick would both be accepted.
        const busy = session.status().value.kind === "running" || occupied() || draining;
        const result = await kernel.control({ kind: "prompt", input, ...inputOptions }, async (): Promise<ResponseBody> => {
          if (busy) {
            return { kind: "rejected", code: "busy", reason: "busy" };
          }
          const outcome = await send(input, inputOptions?.images, true);
          return outcome;
        });
        return result;
      },
      steer: async (input: string, inputOptions?: InputOptions): Promise<ControlResult> => {
        const result = await kernel.control({ kind: "steer", input, ...inputOptions }, async (): Promise<ResponseBody> => {
          // A steer continues the turn that runs. With no turn followed there is
          // nothing to continue, and writing would start a turn this session is not
          // following — so the caller keeps the input.
          if (!tracker.busy()) {
            return { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" };
          }
          const outcome = await send(input, inputOptions?.images, false);
          if (outcome.kind === "accepted") {
            const recordIdx = acceptedRecordOf(outcome.native);
            if (tracker.busy()) {
              // Cybion takes the input into the running turn: the request in flight
              // is cancelled, the Thread stays `running`, and the turn keeps going
              // and ends once, after this input.
              tracker.steer(recordIdx);
            } else if (!draining) {
              // The turn ended while the write was in flight, so Cybion started one
              // for this input alone: it is a turn of its own, and nothing else is
              // following it. (A dispatch in flight will follow a turn that already
              // holds this input, so it needs nothing here.)
              await adoptSteer(input, inputOptions?.images, recordIdx);
            }
          }
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
        // `POST /api/threads/{id}/cancel` stops the turn; an API key reaches it,
        // because that router authenticates the same bearer credential. The turn
        // then ends through the Thread's own `stopped` status, not here.
        const result = await kernel.control({ kind: "abort" }, async (): Promise<ResponseBody> => {
          const aborted = tracker.turnId();
          if (aborted === null) {
            return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
          }
          const stopped = await cancelThread(client, thread.id);
          if (stopped.kind !== "accepted") {
            return stopped;
          }
          // The cancel route takes no turn id, so its answer is read rather than
          // trusted: Cybion answers `stopped` only for a Thread it actually stopped,
          // and answers an idle Thread unchanged when the turn had already ended.
          // A turn that came and went while the cancel travelled is not this call's.
          if (answeredStatusOf(stopped.native) !== "stopped" || tracker.turnId() !== aborted) {
            return { kind: "rejected", code: "no_active_turn", reason: "no active turn", native: stopped.native };
          }
          // The Thread carries `stopped` from here on; only this turn may read it
          // as its own end, or the next turn would abort on the same word.
          tracker.stoppedByUs(aborted);
          return stopped;
        });
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
