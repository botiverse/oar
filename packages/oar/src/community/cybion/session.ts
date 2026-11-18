import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { ControlResult, InputOptions, PromptOptions, ResponseBody, Session, StartSession } from "../../contracts/session.js";
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
 * - queue: held here and sent when the Thread goes idle; the Agent API takes
 *   one input at a time, and a second input while one runs would be a turn of
 *   its own that the Thread's status cannot tell from this one.
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
  readonly inputId?: string | undefined;
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
    const held: Held[] = [];
    let disposed = false;
    const capabilities = { queue: { durable: false }, attribution: "none", images: true } as const;

    const send = async (input: string, images: InputOptions["images"]): Promise<ResponseBody> => {
      const refused = inputImagesRefusal(capabilities, images);
      if (refused !== null) {
        return refused;
      }
      const outcome = await withInputImages(capabilities, images, async (loaded) => {
        try {
          const answer = await submitInput(client, thread.id, input, loaded.map((image) => `data:${image.mediaType};base64,${image.data}`));
          tracker.follow(acceptedRecordOf(answer));
          return { kind: "accepted", native: answer };
        } catch (error) {
          return refusalOf(error);
        }
      });
      return outcome;
    };

    const tracker: ThreadTracker = createThreadTracker({
      client,
      kernel,
      thread,
      // The stream is what this process observes: the Thread's earlier records
      // are not replayed, so a resumed session starts at its own next turn.
      seen: await lastRecordOf(client, thread.id),
      onIdle: () => {
        const next = disposed ? undefined : held.shift();
        if (next !== undefined) {
          void send(next.input, next.images);
        }
      },
      onUnreachable: null,
    });

    const session: Session = sealSession({
      id: kernel.sessionId,
      capabilities,
      prompt: async (input: string, inputOptions?: PromptOptions): Promise<ControlResult> => {
        // Busy is the status fold's word as the request is recorded (`control()`
        // records it synchronously), so the contract's invariant holds by
        // construction: a prompt sent while the Thread runs is refused, and one
        // sent while it idles is never refused `busy`.
        const running = session.status().value.kind === "running";
        const result = await kernel.control({ kind: "prompt", input, ...inputOptions }, async (): Promise<ResponseBody> => {
          if (running) {
            return { kind: "rejected", code: "busy", reason: "busy" };
          }
          const outcome = await send(input, inputOptions?.images);
          return outcome;
        });
        return result;
      },
      queue: async (input: string, inputOptions?: InputOptions): Promise<ControlResult> => {
        const result = await kernel.control({ kind: "queue", input, ...inputOptions }, async (): Promise<ResponseBody> => {
          const refused = inputImagesRefusal(capabilities, inputOptions?.images);
          if (refused !== null) {
            return refused;
          }
          if (tracker.busy()) {
            held.push({ input, inputId: inputOptions?.inputId, images: inputOptions?.images });
            return { kind: "accepted" };
          }
          const outcome = await send(input, inputOptions?.images);
          return outcome;
        });
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
