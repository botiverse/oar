import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { ControlResult, InputOptions, InputOrigin, RequestRecord, ResponseBody, Session, StartSession } from "../../contracts/session.js";
import { enqueueHeld, withdrawControl } from "../../shared/held-input.js";
import { inputImagesRefusal } from "../../shared/input-images.js";
import { sealSession } from "../../shared/seal-session.js";
import { createSessionKernel } from "../../shared/session-kernel.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { acquireConsole, morphStateDir, type ConsoleLease } from "./console.js";
import { MorphRefusalError, carrierTask, morphRefusal, prepareTopic, stopTask, submitTask } from "./topic.js";
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
  modelRequests: "This adapter has no verified capture of the root agent's provider request",
  fork: "OAR has not verified a native Morph fork that opens a copy of a saved session under a new id, cut after a chosen turn",
  goals: "This runtime interface exposes no structured native goal controls",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted Morph turn's processes while its session stays usable",
  userConfiguration: "morph shares its Console process; no per-session exclusion of user configuration is verified",
  systemPrompt: "The morph Runtime API has no system prompt override",
  appendSystemPrompt: "The morph Runtime API has no system prompt override",
  env: "morph runs tools inside its Console process, which a session neither starts nor owns",
  mcpServers: "OAR does not attach MCP servers to morph: no per-session channel is known",
  launchArgs: "morph sessions run in its Console process, which a session neither starts nor owns",
  name: "OAR knows no morph session name setting",
  sessionLogUpload: "This adapter has no verified switch to stop vendor session-log upload",
  nativePermissions: "This adapter has no verified per-session switch to inherit native permission and sandbox settings",
  userQuestions: "This adapter has no verified way for a host to answer the agent's questions",
};

interface Held {
  readonly request: RequestRecord;
  readonly input: string;
  readonly inputId?: string | undefined;
  readonly origin?: InputOrigin | undefined;
  accepted?: true;
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
    let dispatching = false;
    let submitting = 0;
    const body = (task: string): Record<string, unknown> => ({
      task,
      topic_id: topicId,
      workspace_dir: options.cwd,
      ...(options.model === undefined ? {} : { llm_profile: options.model }),
    });
    // The runtime went away without anyone asking: one exit, then nothing runs.
    const lost = (code: number | null): void => {
      if (kernel.unreachable() !== null) {
        return;
      }
      held.length = 0;
      tracker.close();
      kernel.respond("", { kind: "exited", code });
    };
    const send = async (input: string): Promise<{ readonly response: ResponseBody; readonly answered: boolean }> => {
      try {
        const answer = await submitTask(client, body(input));
        tracker.follow(carrierTask(answer));
        return { response: { kind: "accepted", native: answer }, answered: true };
      } catch (error) {
        return { response: morphRefusal(error), answered: error instanceof MorphRefusalError };
      }
    };
    const dispatch = async (request: RequestRecord, next: Held): Promise<void> => {
      try {
        const sent = await send(next.input);
        dispatching = false;
        const stopped = kernel.unreachable();
        if (stopped !== null) {
          kernel.respond(request.id, sent.response.kind === "accepted" ? sent.response : stopped);
          return;
        }
        if (sent.response.kind === "rejected") {
          if (sent.answered) {
            kernel.frame({
              type: "morph/send_rejected",
              native: sent.response.native ?? null,
              events: [{
                kind: "input_dropped",
                requestId: request.id,
                ...(next.inputId === undefined ? {} : { inputId: next.inputId }),
                reason: "runtime_refused",
                message: sent.response.reason,
              }],
            });
          } else {
            held.unshift(next);
          }
        }
        kernel.respond(request.id, sent.response);
        if (sent.response.kind === "rejected" && sent.answered) { drainHeld(); }
      } finally {
        dispatching = false;
      }
    };
    function drainHeld(): void {
      if (kernel.unreachable() !== null || dispatching || submitting > 0 || tracker.busy() || held[0]?.accepted !== true) { return; }
      const next = held.shift();
      if (next === undefined) { return; }
      dispatching = true;
      const request = kernel.request("toRuntime", {
        kind: "prompt",
        input: next.input,
        carries: [next.inputId ?? next.request.id],
        ...(next.origin === undefined ? {} : { origin: next.origin }),
      });
      const blocked = kernel.unreachable();
      if (blocked !== null) {
        dispatching = false;
        kernel.respond(request.id, blocked);
        return;
      }
      void dispatch(request, next);
    }
    const tracker = createTaskTracker({
      client,
      kernel,
      topicId,
      onIdle: () => { drainHeld(); },
      onUnreachable: lease.owned ? null : (): void => { lost(null); },
    });
    lease.onExit(lost);

    const capabilities = { queue: { durable: false }, attribution: "opaque", images: false } as const;
    const withdrawHeldControl = withdrawControl(kernel, held);
    const session: Session = sealSession({
      id: kernel.sessionId,
      capabilities,
      prompt: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
        // Busy is the status fold's word as the request is recorded (control()
        // records it synchronously), so the contract's invariant holds by
        // construction: a task followed but not yet seen working (a steer that
        // became its own task) does not make the topic busy, and a prompt sent
        // meanwhile is steered into it by Console. Held or draining inputs also
        // keep the slot reserved so a prompt cannot overtake queued work.
        const busy = session.status().value.kind === "running" || held.length > 0 || dispatching || submitting > 0;
        if (!busy) { submitting += 1; }
        try {
          const result = await kernel.control({ kind: "prompt", input, ...inputOptions }, async (): Promise<ResponseBody> => {
            if (busy) { return { kind: "rejected", code: "busy", reason: "busy" }; }
            const refused = inputImagesRefusal(capabilities, inputOptions?.images);
            if (refused !== null) { return refused; }
            const sent = await send(input);
            return sent.response;
          });
          return result;
        } finally {
          if (!busy) { submitting -= 1; }
          drainHeld();
        }
      },
      steer: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
        submitting += 1;
        try {
          const result = await kernel.control({ kind: "steer", input, ...inputOptions }, async (): Promise<ResponseBody> => {
            if (!tracker.busy()) { return { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" }; }
            const refused = inputImagesRefusal(capabilities, inputOptions?.images);
            if (refused !== null) { return refused; }
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
              return morphRefusal(error);
            }
          });
          return result;
        } finally {
          submitting -= 1;
          drainHeld();
        }
      },
      queue: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
        const result = await kernel.control({ kind: "queue", input, ...inputOptions }, (request): ResponseBody => {
          const refused = inputImagesRefusal(capabilities, inputOptions?.images);
          if (refused !== null) { return refused; }
          enqueueHeld(held, {
            request,
            input,
            ...(inputOptions?.inputId === undefined ? {} : { inputId: inputOptions.inputId }),
            ...(inputOptions?.origin === undefined ? {} : { origin: inputOptions.origin }),
          });
          return { kind: "accepted", queued: "adapter" };
        });
        const entry = held.find((item) => item.request.id === result.request.id);
        if (entry !== undefined && result.response.body.kind === "accepted") { entry.accepted = true; }
        drainHeld();
        return result;
      },
      withdraw: async (inputId: string): Promise<ControlResult> => {
        const result = await withdrawHeldControl(inputId);
        drainHeld();
        return result;
      },
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
        await kernel.dispose(async request => {
          held.length = 0;
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
          tracker.close();
          const stopped = await lease.release();
          // A Console this release stopped exits as the answer to the dispose; one
          // still serving other sessions, or the user's own, was only let go.
          kernel.respond(request.id, stopped === null ? { kind: "accepted" } : { kind: "exited", code: stopped.code });
        }, async () => { tracker.close(); await lease.release(); });
      },
    });
    return session;
  };
}

export const morphSession: StartSession = morphSessionWith(acquireConsole);
