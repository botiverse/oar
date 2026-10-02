import type {
  ControlResult,
  InputOptions,
  RequestRecord,
  Session,
  StartSession,
} from "../../contracts/session.js";
import { randomUUID } from "node:crypto";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { withInputImages, type LoadedImage } from "../../shared/input-images.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { sealSession } from "../../shared/seal-session.js";
import { createSessionKernel } from "../../shared/session-kernel.js";
import {
  claudeAbortRequested,
  claudePrompted,
  foldClaudeStdout,
  initialClaudeProjection,
  type ClaudeProjectionState,
} from "./projection.js";
import { createClaudeReadbacks } from "./readback.js";

/*
 * Live semantics this adapter is built on (drydock probes, 2026-08-21):
 * - stdin accepts writes at every phase; a mid-turn write is delivered into
 *   the ACTIVE turn at the next model-step boundary (steer), or becomes the
 *   next turn when no step remains. Landing shows up in the event stream.
 * - each turn is framed by its own system/init … result pair; the `result`
 *   frame is claude's own turn end and becomes the turn_ended event.
 * - `control_request {subtype:"interrupt"}` is acked with control_response
 *   (the abort request's response record) and claude settles the turn with
 *   an error-subtype result.
 * - steer/prompt `accepted` here means: the user message was written to
 *   stdin. Landing (same turn vs auto-queued next turn) is claude's timing and
 *   shows up only in the stream. Live probe: claude-session-adapter.ts.
 * - `SessionOptions.effort` is `--effort` and `SessionOptions.model` is
 *   `--model`, on a resume too; claude's only report of what it runs is its
 *   `get_settings` answer, read at open (effort.ts, model.ts), next to a
 *   `list_models` answer that says what a requested alias means. Those stdout
 *   lines are consumed, NOT recorded: besides `applied` the settings answer
 *   dumps the merged settings of every source (hooks, permissions, any `env`
 *   block) verbatim, and a read-back oar asks for must not publish a user's
 *   settings into every consumer's log. Like codex's `initialize` reply, they
 *   are the adapter's plumbing, not the session's words; every other line is
 *   a frame.
 * - On `--resume` claude replays the system prompt it snapshotted when the
 *   session began and silently ignores a new `--system-prompt` or
 *   `--append-system-prompt`; `--system-prompt-snapshot off` makes it render
 *   the prompt fresh from the flags (claude 2.1.284, probed 2026-09-30), so
 *   the adapter passes it whenever a resume brings either prompt.
 */

/** One stream-json user message; images go before the text, as the Messages API recommends. */
function userMessage(text: string, inputId?: string, images: readonly LoadedImage[] = []): string {
  return `${JSON.stringify({
    type: "user",
    ...(inputId === undefined ? {} : { uuid: inputId }),
    message: {
      role: "user",
      content: [
        ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
        { type: "text", text },
      ],
    },
  })}\n`;
}

interface ClaudeSessionState {
  child: LineProcess;
  /** The prompt request whose turn is running; null while idle. Spontaneous turns (a drained queue message) run with no request. */
  active: RequestRecord | null;
  /** True while claude is executing a turn we did not prompt (queue drain). */
  spontaneous: boolean;
  projection: ClaudeProjectionState;
  disposed: boolean;
}

export const claudeSession: StartSession = async (installation, options) => {
  if (installation.via !== "executable") {
    throw new Error("The claude session adapter needs an executable installation");
  }
  // Session identity is claude's own: we either choose it up front
  // (--session-id) or reattach to an existing one (--resume), so Session.id
  // is always the runtime-native persistent id.
  const sessionId = options.resume ?? randomUUID();
  const child = spawnLineProcess(installation.command, [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose", "--replay-user-messages",
    // YOLO by default (repo policy, 2026-08-24): in embedded/SDK use there is
    // no human at an approval prompt: a permission gate is a hang, not
    // safety. Isolation is the sandbox's job, not the approval flow's.
    "--dangerously-skip-permissions",
    ...(options.resume === undefined ? ["--session-id", sessionId] : ["--resume", sessionId]),
    ...(options.model === undefined ? [] : ["--model", options.model]),
    ...(options.effort === undefined ? [] : ["--effort", options.effort]),
    ...(options.systemPrompt === undefined ? [] : ["--system-prompt", options.systemPrompt]),
    ...(options.appendSystemPrompt === undefined ? [] : ["--append-system-prompt", options.appendSystemPrompt]),
    ...(options.resume !== undefined && (options.systemPrompt !== undefined || options.appendSystemPrompt !== undefined)
      ? ["--system-prompt-snapshot", "off"]
      : []),
  ], {
    cwd: options.cwd,
    env: { ...process.env, CLAUDECODE: undefined, ...options.env },
  });
  await child.spawned;

  const kernel = createSessionKernel(sessionId);
  const state: ClaudeSessionState = {
    child,
    active: null,
    spontaneous: false,
    projection: initialClaudeProjection,
    disposed: false,
  };
  // claude cannot hold input for a LATER turn natively (an active-turn write
  // steers), so queueing is adapter-held: drained one message per turn end.
  const heldQueue: { input: string; inputId?: string; images: readonly LoadedImage[] }[] = [];
  const busy = (): boolean => state.active !== null || state.spontaneous;
  let disposeRequest: RequestRecord | null = null;
  // The read-backs asked at open (see the header): their answers are taken
  // off the line stream before the fold.
  const readbacks = createClaudeReadbacks((line) => {
    child.write(line);
  });

  // Drive the pure projection fold, applying its commands to the kernel. The
  // fold owns event translation and attribution; this owns only transport
  // and the control decisions (busy, queue drain).
  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message === null) {
      return;
    }
    if (readbacks.take(message)) {
      return;
    }
    // A system/init while nothing is active is claude starting a turn on its
    // own (a queued or late-steered message): a spontaneous turn.
    if (message.type === "system" && message.subtype === "init" && !busy()) {
      state.spontaneous = true;
    }
    const { state: nextProjection, commands } = foldClaudeStdout(state.projection, message);
    state.projection = nextProjection;
    let ended = false;
    for (const command of commands) {
      switch (command.kind) {
        case "frame": {
          const record = kernel.frame(command.body, { agentPath: command.agentPath });
          if (record.agentPath.length === 0 && command.body.events.some((event) => event.kind === "turn_ended")) {
            ended = true;
          }
          break;
        }
        case "respond":
          kernel.respond(command.requestId, command.body);
          break;
        case "toApp":
          kernel.request("toApp", { kind: "native", type: command.type, native: command.native }, { id: command.id });
          break;
        default:
          break;
      }
    }
    if (ended) {
      state.active = null;
      state.spontaneous = false;
      if (!state.disposed) {
        const next = heldQueue.shift();
        if (next !== undefined) {
          child.write(userMessage(next.input, next.inputId, next.images));
        }
      }
    }
  });
  child.onExit((code) => {
    // The exit is an outcome only oar observes: it answers our dispose when
    // we caused it, and stands alone when claude died on its own.
    kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code });
    state.active = null;
    state.spontaneous = false;
    readbacks.exited(code);
  });

  // Never run a silently different model or effort: ask claude what it will
  // send and refuse to open on anything but what was requested.
  const refusal = await readbacks.refusal(options);
  if (refusal !== null) {
    child.kill();
    await child.exited;
    throw new Error(refusal);
  }

  let interruptCounter = 0;
  const capabilities = { steer: true, queue: { durable: false }, attribution: "attributed", images: true } as const;
  const session: Session = sealSession({
    id: kernel.sessionId,
    capabilities,
    prompt: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
      const body = { kind: "prompt" as const, input, ...inputOptions };
      const result = await kernel.control(body, (request) => {
      if (busy()) {
        return { kind: "rejected", code: "busy", reason: "busy" };
      }
      return withInputImages(capabilities, inputOptions?.images, (images) => {
        state.active = request;
        state.projection = claudePrompted(state.projection);
        child.write(userMessage(input, inputOptions?.inputId, images));
        return { kind: "accepted" };
      });
      });
      return result;
    },
    steer: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
      const result = await kernel.control({ kind: "steer", input, ...inputOptions }, () => {
      if (!busy()) {
        return { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" };
      }
      return withInputImages(capabilities, inputOptions?.images, (images) => {
        child.write(userMessage(input, inputOptions?.inputId, images));
        return { kind: "accepted" };
      });
      });
      return result;
    },
    queue: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
      const result = await kernel.control({ kind: "queue", input, ...inputOptions }, () =>
        withInputImages(capabilities, inputOptions?.images, (images) => {
          if (busy()) {
            heldQueue.push({ input, ...(inputOptions?.inputId === undefined ? {} : { inputId: inputOptions.inputId }), images });
          } else {
            child.write(userMessage(input, inputOptions?.inputId, images));
          }
          return { kind: "accepted" };
        }));
      return result;
    },
    abort: async (): Promise<ControlResult> => {
      // The interrupt's outcome is claude's control_response, which the fold
      // routes to THIS request id; the turn's end is claude's result frame.
      interruptCounter += 1;
      const requestId = `interrupt-${interruptCounter}`;
      // Recorded by hand (not kernel.control) because claude's control_response
      // is the answer, routed to this id by the fold, so the reachability gate
      // is applied here explicitly.
      const blocked = kernel.unreachable();
      const request = kernel.request("toRuntime", { kind: "abort" }, { id: requestId });
      if (blocked !== null || !busy()) {
        return { request, response: kernel.respond(request.id, blocked ?? { kind: "rejected", code: "no_active_turn", reason: "no active turn" }) };
      }
      state.projection = claudeAbortRequested(state.projection);
      const { promise, resolve } = Promise.withResolvers<ControlResult>();
      const unsubscribe = kernel.rawEvents((record) => {
        if (record.kind === "response" && record.requestId === requestId) {
          resolve({ request, response: record });
        }
      });
      child.write(`${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "interrupt" },
      })}\n`);
      const result = await promise;
      unsubscribe();
      return result;
    },
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    dispose: async () => {
      if (state.disposed) {
        return;
      }
      state.disposed = true;
      const gone = kernel.unreachable() !== null; // only an observed exit can say so before this dispose is recorded
      disposeRequest = kernel.request("toRuntime", { kind: "dispose" });
      if (gone) {
        // The exit is already recorded; nothing is left to release.
        kernel.respond(disposeRequest.id, { kind: "accepted" });
        return;
      }
      child.kill();
      await child.exited; // release point for anything the process held; the exit response is recorded by onExit
    },
  });
  return session;
};
