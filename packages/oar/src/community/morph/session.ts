import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { ControlResult, InputOptions, ResponseBody, Session, StartSession } from "../../contracts/session.js";
import { withdrawControl } from "../../shared/held-input.js";
import { inputImagesRefusal } from "../../shared/input-images.js";
import { sealSession } from "../../shared/seal-session.js";
import { createSessionKernel } from "../../shared/session-kernel.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { acquireConsole, morphStateDir, type ConsoleLease } from "./console.js";
import { MorphRefusalError, carrierTask, checkProfile, openTopic, stopTask, submitTask } from "./topic.js";
import { createTaskTracker } from "./tracker.js";

/*
 * One OAR session is one morph Console topic (Session.id = topic id), driven
 * through the Console Runtime API (mistermorph docs/runtime-api.md; probe:
 * experiments/morph-runtime-probe.ts):
 *
 * - open: `POST /topics` creates the empty topic (resume: `GET /topics/{id}`),
 *   and `PUT /workspace` attaches `cwd` to it, on resume too, so the topic
 *   runs where this session says.
 * - prompt: `POST /tasks {task, topic_id}`; the answer's task is the turn,
 *   followed by tracker.ts until its terminal status.
 * - steer: the same `POST /tasks` while the topic runs. Console injects it
 *   into the run and answers a completed acknowledgement naming
 *   `steer_target_task_id`. When the run ended first, the text started a task
 *   of its own: it is followed as a spontaneous turn.
 * - abort: `POST /tasks/{id}/stop`; the outcome is the task's `canceled`.
 * - queue: held here and sent when the topic goes idle.
 *
 * Console is not this session's process: it is the user's own (never stopped
 * by OAR) or one this process started for every session on the same state
 * directory (console.ts). Text sent to a topic is read as a Console runtime
 * command when it is one (`/reset`, `/models ...`), as in Console itself.
 */

/** How long dispose waits for a stopped task's own `canceled` before letting go. */
const DISPOSE_SETTLE_MS = 3000;

export const morphRefusedSessionOptions: RefusedSessionOptions = {
  systemPrompt: "The morph Runtime API has no system prompt override",
  appendSystemPrompt: "The morph Runtime API has no system prompt override",
  env: "morph runs tools inside its Console process, which a session neither starts nor owns",
  mcpServers: "OAR does not attach MCP servers to morph: no per-session channel is known",
};

interface Held {
  readonly input: string;
  readonly inputId?: string | undefined;
}

function refusal(error: unknown): ResponseBody {
  return error instanceof MorphRefusalError
    ? { kind: "rejected", code: error.refused ? "runtime_refused" : "error", reason: error.message, native: error.native }
    : { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) };
}

async function prepareTopic(client: Parameters<typeof openTopic>[0], options: Parameters<StartSession>[1]): Promise<string> {
  if (options.model !== undefined) {
    await checkProfile(client, options.model);
  }
  const topicId = await openTopic(client, options.resume);
  await client.expect("PUT", "/workspace", { topic_id: topicId, workspace_dir: options.cwd });
  return topicId;
}

/** How a session gets its Console; tests hand in a scripted one. */
export type AcquireConsole = (command: string, stateDir: string) => Promise<ConsoleLease>;

export function morphSessionWith(acquire: AcquireConsole): StartSession {
  return async (installation, options) => {
    if (installation.via !== "executable") {
      throw new Error("The morph session adapter needs an executable installation");
    }
    refuseSessionOptions(morphRefusedSessionOptions, options);
    if (options.effort !== undefined) {
      throw new Error(`morph's Runtime API has no reasoning-effort channel, so effort ${options.effort} cannot be applied`);
    }
    const lease = await acquire(installation.command, morphStateDir());
    const { client } = lease;
    const topicId = await prepareTopic(client, options).catch(async (error: unknown) => {
      await lease.release();
      throw error;
    });

    const kernel = createSessionKernel(topicId);
    const held: Held[] = [];
    let disposed = false;
    const body = (task: string): Record<string, unknown> => ({
      task,
      topic_id: topicId,
      workspace_dir: options.cwd,
      ...(options.model === undefined ? {} : { llm_profile: options.model }),
    });
    // The runtime went away without anyone asking: one exit, then nothing runs.
    const lost = (code: number | null): void => {
      if (kernel.unreachable() === null) {
        kernel.respond("", { kind: "exited", code });
      }
      tracker.close();
      held.length = 0;
    };
    const tracker = createTaskTracker({
      client,
      kernel,
      topicId,
      onIdle: () => {
        const next = disposed ? undefined : held.shift();
        if (next !== undefined) {
          // The input was taken over at queue time; a send that fails leaves no turn.
          void send(next.input);
        }
      },
      onUnreachable: lease.owned ? null : (): void => {
        lost(null);
      },
    });
    lease.onExit(lost);

    const send = async (input: string): Promise<ResponseBody> => {
      try {
        const answer = await submitTask(client, body(input));
        tracker.follow(carrierTask(answer));
        return { kind: "accepted", native: answer };
      } catch (error) {
        return refusal(error);
      }
    };

    const capabilities = { queue: { durable: false }, attribution: "opaque", images: false } as const;
    const session: Session = sealSession({
      id: kernel.sessionId,
      capabilities,
      prompt: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
        // Busy is the status fold's word as the request is recorded (control()
        // records it synchronously), so the contract's invariant holds by
        // construction: a task followed but not yet seen working (a steer that
        // became its own task) does not make the topic busy, and a prompt sent
        // meanwhile is steered into it by Console.
        const running = session.status().value.kind === "running";
        const result = await kernel.control({ kind: "prompt", input, ...inputOptions }, async (): Promise<ResponseBody> => {
          if (running) {
            return { kind: "rejected", code: "busy", reason: "busy" };
          }
          const refused = inputImagesRefusal(capabilities, inputOptions?.images);
          if (refused !== null) {
            return refused;
          }
          const outcome = await send(input);
          return outcome;
        });
        return result;
      },
      steer: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
        const result = await kernel.control({ kind: "steer", input, ...inputOptions }, async (): Promise<ResponseBody> => {
          if (!tracker.busy()) {
            return { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" };
          }
          const refused = inputImagesRefusal(capabilities, inputOptions?.images);
          if (refused !== null) {
            return refused;
          }
          try {
            const answer = await submitTask(client, body(input));
            if (carrierTask(answer) === answer.id && answer.status === "done") {
              // Console found the run but did not hold the input for it.
              return { kind: "rejected", code: "runtime_refused", reason: "not_steerable: morph did not queue the input for the running task", native: answer };
            }
            // Steered into the run, or (the run ended first) a task of its own.
            tracker.follow(carrierTask(answer));
            return { kind: "accepted", native: answer };
          } catch (error) {
            return refusal(error);
          }
        });
        return result;
      },
      queue: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
        const result = await kernel.control({ kind: "queue", input, ...inputOptions }, async (): Promise<ResponseBody> => {
          const refused = inputImagesRefusal(capabilities, inputOptions?.images);
          if (refused !== null) {
            return refused;
          }
          if (tracker.busy()) {
            held.push({ input, inputId: inputOptions?.inputId });
            return { kind: "accepted" };
          }
          const outcome = await send(input);
          return outcome;
        });
        return result;
      },
      withdraw: withdrawControl(kernel, held),
      abort: async (): Promise<ControlResult> => {
        const result = await kernel.control({ kind: "abort" }, async (): Promise<ResponseBody> => {
          const active = tracker.active();
          if (active === null) {
            return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
          }
          const outcome = await stopTask(client, active);
          return outcome;
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
        if (!gone) {
          const active = tracker.active();
          if (active !== null) {
            // The task's own `canceled` ends the turn in the stream, if it comes in time.
            try {
              await stopTask(client, active);
            } catch {
              // Console may already be gone; releasing still settles.
            }
            await tracker.settle(DISPOSE_SETTLE_MS);
          }
        }
        tracker.close();
        const stopped = await lease.release();
        // A Console this release stopped exits as the answer to the dispose; one
        // still serving other sessions, or the user's own, was only let go.
        kernel.respond(request.id, stopped === null || gone ? { kind: "accepted" } : { kind: "exited", code: stopped.code });
      },
    });
    return session;
  };
}

export const morphSession: StartSession = morphSessionWith(acquireConsole);
