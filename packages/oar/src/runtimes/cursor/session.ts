import type {
  ControlResult,
  InputOptions,
  RequestRecord,
  ResponseBody,
  Session,
  SessionOptions,
  StartSession,
} from "../../contracts/session.js";
import { withInputImages, type LoadedImage } from "../../shared/input-images.js";
import { sealSession } from "../../shared/seal-session.js";
import { createSessionKernel } from "../../shared/session-kernel.js";
import { cursorModelSelection } from "./model.js";
import {
  cursorOpenedFrame,
  cursorRunFailedFrame,
  cursorRunResultFrame,
  foldCursorDelta,
  initialCursorProjection,
  type CursorFrame,
  type CursorProjectionState,
} from "./projection.js";
import { settled, steerRun, type ActiveRun } from "./run.js";
import { loadCursorSdk, type CursorDeltaListener, type CursorSdk } from "./sdk.js";

/*
 * Cursor through `@cursor/sdk` (1.0.35), in process (settled 2026-10-03,
 * replacing cursor-agent ACP): a session is one local SDK agent, its id the
 * SDK's `agent-<uuid>`; a turn is one `send`, from the run it returns until
 * `run.wait()` answers; steer is `run.steer`; abort is `run.cancel`; the
 * agent takes one run at a time (a second `send` is refused "already has
 * active run"), so queued input is held here and sent when the run ends.
 */

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** How long dispose waits for a cancelled run to report its own end before releasing the agent. */
const DISPOSE_SETTLE_MS = 5000;

function validateCursorOptions(options: SessionOptions): void {
  if (options.systemPrompt !== undefined || options.appendSystemPrompt !== undefined) {
    // SDK 1.0.35 types a `systemPrompt`, but a local agent's run fails with
    // "unknown option '--system-prompt'" (probed 2026-10-03), and there is no append.
    throw new Error("Cursor's SDK runs no system prompt override for a local agent");
  }
  if (options.env !== undefined && Object.keys(options.env).length > 0) {
    throw new Error("Cursor runs in this process and its SDK takes no environment for the agent's tools; SessionOptions.env is unsupported");
  }
}

export function cursorSessionWith(load: () => Promise<CursorSdk>): StartSession {
  return async (installation, options) => {
    if (installation.via !== "bundled") {
      throw new Error("The cursor session adapter needs the bundled @cursor/sdk installation");
    }
    validateCursorOptions(options);
    const sdk = await load();
    // No sandbox, as every OAR session runs by default (contracts/session.ts):
    // without this a `~/.cursor/sandbox.json` would turn one on.
    const agentOptions = {
      model: await cursorModelSelection(sdk, options),
      local: { cwd: options.cwd, sandboxOptions: { enabled: false } },
    };
    const agent = options.resume === undefined
      ? await sdk.Agent.create(agentOptions)
      : await sdk.Agent.resume(options.resume, agentOptions);

    const kernel = createSessionKernel(agent.agentId);
    let projection: CursorProjectionState = initialCursorProjection;
    // A turn is running from an accepted prompt (or a drained queue input)
    // until its run's end is recorded. Held in an object so closures always
    // read the live value.
    const gate = { running: false };
    // The run being sent (null until `send` returns it) and the run in flight.
    let sending: Promise<ActiveRun | null> | null = null;
    let active: ActiveRun | null = null;
    let pendingAbort = false;
    let disposeRequest: RequestRecord | null = null;
    // Adapter-held queue, drained one input per run end.
    const held: { readonly input: string; readonly images: readonly LoadedImage[] }[] = [];

    const record = (frame: CursorFrame): void => {
      kernel.frame(
        { type: frame.type, native: frame.native, events: frame.events },
        frame.agentPath.length === 0 ? undefined : { agentPath: frame.agentPath },
      );
    };
    const onDelta: CursorDeltaListener = ({ update }) => {
      const folded = foldCursorDelta(projection, update);
      projection = folded.state;
      record(folded.frame);
    };
    record(cursorOpenedFrame(agent.agentId, agent.model));

    const finish = (current: ActiveRun | null, frame: CursorFrame): void => {
      record(frame);
      if (active === current) {
        active = null;
      }
      gate.running = false;
      drainHeld();
    };

    const send = async (input: string, images: readonly LoadedImage[]): Promise<ActiveRun> => {
      const content = images.length === 0
        ? input
        : { text: input, images: images.map((image) => ({ data: image.data, mimeType: image.mediaType })) };
      const run = await agent.send(content, { onDelta });
      const { promise: ended, resolve: onEnded } = Promise.withResolvers<void>();
      const current: ActiveRun = { run, ended };
      active = current;
      void (async (): Promise<void> => {
        try {
          finish(current, cursorRunResultFrame(await run.wait()));
        } catch (error) {
          finish(current, cursorRunFailedFrame(message(error)));
        } finally {
          onEnded();
        }
      })();
      return current;
    };

    const start = async (input: string, images: readonly LoadedImage[]): Promise<ResponseBody> => {
      gate.running = true;
      const sent = settled(send(input, images));
      sending = (async (): Promise<ActiveRun | null> => {
        const outcome = await sent;
        return "value" in outcome ? outcome.value : null;
      })();
      const outcome = await sent;
      sending = null;
      if ("error" in outcome) {
        gate.running = false;
        pendingAbort = false;
        return { kind: "rejected", code: "runtime_refused", reason: message(outcome.error) };
      }
      const current = outcome.value;
      if (pendingAbort) {
        // The abort was accepted before the run existed; its outcome is the
        // run's own end, so a failed cancel leaves the run to finish.
        pendingAbort = false;
        try {
          await current.run.cancel();
        } catch {
          // The run may have ended on its own meanwhile.
        }
      }
      return { kind: "accepted", native: { runId: current.run.id } };
    };

    function drainHeld(): void {
      if (disposeRequest !== null || gate.running) {
        return;
      }
      const next = held.shift();
      if (next === undefined) {
        return;
      }
      void (async (): Promise<void> => {
        const decided = await start(next.input, next.images);
        if (decided.kind === "rejected") {
          // The queue took the input over; the SDK refusing it is not silent.
          kernel.frame({ type: "cursor/send_rejected", native: { message: decided.reason, input: next.input }, events: [] });
          drainHeld();
        }
      })();
    }

    /** The run in flight, waiting out a `send` that has not returned it yet. */
    const inFlight = async (): Promise<ActiveRun | null> => active ?? (sending === null ? null : await sending);

    const capabilities = { steer: true, queue: { durable: false }, attribution: "attributed", images: true } as const;
    const session: Session = sealSession({
      id: kernel.sessionId,
      capabilities,
      prompt: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
        const result = await kernel.control({ kind: "prompt", input, ...inputOptions }, async () => {
          if (gate.running) {
            return { kind: "rejected", code: "busy", reason: "busy" };
          }
          const decided = await withInputImages(capabilities, inputOptions?.images, async (images) => {
            const started = await start(input, images);
            return started;
          });
          return decided;
        });
        return result;
      },
      steer: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
        const result = await kernel.control({ kind: "steer", input, ...inputOptions }, async () => {
          const current = gate.running ? await inFlight() : null;
          if (current === null) {
            return { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" };
          }
          if ((inputOptions?.images ?? []).length > 0) {
            return { kind: "rejected", code: "unsupported", reason: "not_steerable: cursor steers with text only" };
          }
          const decided = await steerRun(current, input);
          return decided;
        });
        return result;
      },
      queue: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
        const result = await kernel.control({ kind: "queue", input, ...inputOptions }, () =>
          withInputImages(capabilities, inputOptions?.images, (images) => {
            held.push({ input, images });
            drainHeld();
            return { kind: "accepted" };
          }));
        return result;
      },
      abort: async (): Promise<ControlResult> => {
        const result = await kernel.control({ kind: "abort" }, async () => {
          if (!gate.running) {
            return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
          }
          if (active === null) {
            // The run does not exist yet: cancelled as soon as `send` returns it.
            pendingAbort = true;
            return { kind: "accepted" };
          }
          // Accepted means taken over; the outcome is the run's own `cancelled`.
          await active.run.cancel();
          return { kind: "accepted" };
        });
        return result;
      },
      rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
      records: () => kernel.records(),
      graph: () => kernel.graph(),
      dispose: async () => {
        if (disposeRequest !== null) {
          return;
        }
        held.splice(0);
        const request = kernel.request("toRuntime", { kind: "dispose" });
        disposeRequest = request;
        const current = gate.running ? await inFlight() : null;
        if (current !== null) {
          // The run's own `cancelled` ends the turn in the stream.
          try {
            await current.run.cancel();
          } catch {
            // The run may have ended on its own meanwhile.
          }
          await Promise.race([current.ended, new Promise<void>((resolve) => {
            setTimeout(resolve, DISPOSE_SETTLE_MS).unref();
          })]);
        }
        agent.close();
        // The agent runs in this process: there is no process exit to
        // observe, so the dispose is answered as taken over.
        kernel.respond(request.id, { kind: "accepted" });
      },
    });
    return session;
  };
}

export const cursorSession: StartSession = cursorSessionWith(loadCursorSdk);
