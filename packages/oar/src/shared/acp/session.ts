/* oxlint-disable typescript/promise-function-async -- SDK callbacks deliberately return the SDK's native promises. */
import type { AvailableInstallation } from "../../contracts/installation.js";
import type {
  ControlResult,
  InputOptions,
  RequestBody,
  RequestRecord,
  ResponseBody,
  Session,
  SessionOptions,
  StartSession,
} from "../../contracts/session.js";
import { sealSession } from "../seal-session.js";
import { createSessionKernel } from "../session-kernel.js";
import { createAcpAsking, createAcpClientApp } from "./client-app.js";
import {
  closeAcpSession,
  createUsageUpdateGate,
  openAcpSession,
  type AcpSessionProfile,
} from "./profile.js";
import { startAcpProcess } from "./process.js";
import { createAcpRecorder } from "./records.js";
import { createAcpTerminalHost } from "./terminal.js";
import { createAcpTurns } from "./turns.js";

export type { AcpSessionProfile } from "./profile.js";

/*
 * ACP mapping onto the record stream (shared by grok and kimi; profiles carry the vendor bits):
 * - every `session/update` is ONE event record, native verbatim, for WHATEVER
 *   session id it names: a foreign id is a derived child session (records.ts).
 * - vendor extension notifications the profile lists are recorded verbatim.
 * - runtime→app requests (permission, terminal) are toApp request records;
 *   oar's automatic answer is the matching `answered` response (client-app.ts).
 *   Under SessionOptions.approvals "ask" a permission request (with what it
 *   asks, approvals.ts) instead waits for Session.answer; an abort answers
 *   the ones still waiting `cancelled`, as ACP requires.
 * - prompt / steer / queue / abort / dispose are toRuntime requests answered
 *   accepted-or-rejected; the turn's end is the runtime's own prompt answer
 *   (turns.ts) or the process exit oar observed (`exited` response).
 */

export function acpSession(profile: AcpSessionProfile): StartSession {
  return async (installation: AvailableInstallation, options: SessionOptions): Promise<Session> => {
    if (installation.via !== "executable") {
      throw new Error("ACP runtimes require an executable installation");
    }
    profile.validateOptions?.(options);
    if (options.approvals === "ask" && profile.capabilities.approvals.kind === "unsupported") {
      throw new Error(`approvals "ask" is unsupported here: ${profile.capabilities.approvals.reason}`);
    }
    const args = typeof profile.args === "function" ? profile.args(options) : profile.args;
    const environment = { ...process.env, ...options.env };
    const terminalHost = createAcpTerminalHost(options.cwd, environment, {
      shellCommand: profile.terminalShellCommand === true,
    });
    // The recorder queues everything until the handshake reveals the session
    // id and the kernel can be bound (records.ts).
    const usageGate = createUsageUpdateGate();
    const permissions = { allowAlwaysIsSession: profile.allowAlwaysIsSession === true };
    const recorder = createAcpRecorder(usageGate, permissions);
    // approvals "ask": each permission request waits here, its JSON-RPC
    // reply unsent, until Session.answer settles it (or the turn is cancelled).
    const asking = createAcpAsking(permissions);
    const askPermission = options.approvals === "ask" ? asking.askPermission : undefined;
    const client = createAcpClientApp(terminalHost, {
      ...(askPermission === undefined ? {} : { askPermission }),
      update: (notification) => {
        recorder.update(notification);
      },
      extension: (method, params) => {
        recorder.extension(method, params);
      },
      requested: (id, method, params) => {
        recorder.requested(id, method, params);
      },
      answered: (id, reply) => {
        recorder.answered(id, reply);
      },
      extensionNotifications: profile.extensionNotifications ?? [],
    });
    const runtime = startAcpProcess(installation.command, args, client, { cwd: options.cwd, env: environment });
    const opened = await openAcpSession(runtime, profile, options, (step) => {
      recorder.step(step.method, step.response);
    }).catch(async (error: unknown) => {
      runtime.kill();
      await runtime.exited;
      await terminalHost.dispose();
      throw error;
    });
    const kernel = createSessionKernel(opened.sessionId);
    recorder.bind(kernel);

    let disposeRequest: RequestRecord | null = null;
    const turns = createAcpTurns({ kernel, runtime, profile, usageGate });
    // oxlint-disable-next-line promise/prefer-await-to-then, promise/always-return -- Exit observation outlives session creation.
    void runtime.exited.then((code) => {
      void terminalHost.dispose();
      // An outcome only oar observes: answers our dispose when we caused the
      // exit, stands alone (requestId "") when the runtime died on its own.
      // It voids every permission request still waiting: nothing can take a
      // reply any more.
      kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code });
      asking.clear();
      turns.onExit();
    });
    // ACP: a client that cancels a turn "MUST respond `cancelled`" to each of
    // its pending permission requests: oar's own answer, recorded as the
    // request's `answered` response like any automatic one.
    const cancelAsking = (): void => {
      asking.cancelAll((id, reply) => {
        recorder.answered(id, reply);
      });
    };

    // Reachability (exited, disposed) is the kernel's gate, read off the
    // stream; the adapter decides only the runtime-specific answers (busy,
    // not_steerable). `runtime.closed` flips synchronously on the process's
    // exit, one microtask before the observer above records the `exited`
    // response: a control landing in that window would otherwise be decided
    // here (rejected "ACP process exited") instead of by the gate, so the
    // exit is let land first.
    const control = async (
      body: RequestBody,
      decide: (request: RequestRecord) => ResponseBody | Promise<ResponseBody>,
    ): Promise<ControlResult> => {
      if (runtime.closed && kernel.unreachable() === null) {
        await runtime.exited;
      }
      return kernel.control(body, decide);
    };

    return sealSession({
      id: kernel.sessionId,
      capabilities: profile.capabilities,
      prompt: (input, inputOptions?: InputOptions): Promise<ControlResult> => control({ kind: "prompt", input, ...inputOptions }, (request): ResponseBody =>
        (turns.active() === null ? turns.begin(request, input) : { kind: "rejected", code: "busy", reason: "busy" })),
      steer: (input, inputOptions?: InputOptions): Promise<ControlResult> => control({ kind: "steer", input, ...inputOptions }, (): ResponseBody | Promise<ResponseBody> => {
        const steerParams = profile.steerParams;
        if (steerParams === undefined) {
          return { kind: "rejected", code: "unsupported", reason: "not_steerable: runtime cannot inject into an active turn" };
        }
        const state = turns.active();
        return state === null
          ? { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" }
          : turns.steer(state, input, steerParams(input));
      }),
      queue: (input, inputOptions?: InputOptions): Promise<ControlResult> => control({ kind: "queue", input, ...inputOptions }, () => turns.hold(input)),
      abort: (): Promise<ControlResult> => control({ kind: "abort" }, async (): Promise<ResponseBody> => {
        const state = turns.active();
        if (state === null) {
          return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
        }
        const decided = await turns.abort(state);
        if (decided.kind === "accepted") {
          cancelAsking();
        }
        return decided;
      }),
      // The reply resolves the agent's waiting JSON-RPC request; the SDK
      // sends it. Only permission requests wait: terminals oar serves itself.
      answer: async (requestId, decision) => {
        if (runtime.closed && kernel.unreachable() === null) {
          await runtime.exited;
        }
        return kernel.answer(requestId, decision, (_request, taken) => asking.deliver(requestId, taken));
      },
      rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
      records: () => kernel.records(),
      graph: () => kernel.graph(),
      dispose: async () => {
        if (disposeRequest !== null) {
          return; // already released: the stream holds our dispose request
        }
        // Read BEFORE this dispose is recorded: only an observed exit can say
        // so here, and it is the stream's word, not an adapter flag.
        const gone = kernel.unreachable() !== null;
        disposeRequest = kernel.request("toRuntime", { kind: "dispose" });
        if (gone) {
          // The exit is already recorded (an unrequested `exited` response, requestId "");
          // nothing is left to release, so the dispose is answered here, as
          // the claude and codex adapters do (kimi 0.42.0 kill-runtime run,
          // 2026-09-11: the dispose request stood unanswered before this).
          kernel.respond(disposeRequest.id, { kind: "accepted" });
          await terminalHost.dispose();
          return;
        }
        const state = turns.active();
        if (state !== null && !runtime.closed) {
          await turns.abort(state);
          cancelAsking();
        }
        if (opened.supportsClose && !runtime.closed) {
          await closeAcpSession(runtime, kernel.sessionId).catch(() => {});
        }
        runtime.kill();
        await runtime.exited;
        await terminalHost.dispose();
      },
    });
  };
}
