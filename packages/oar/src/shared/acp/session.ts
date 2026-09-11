/* oxlint-disable typescript/promise-function-async -- SDK callbacks deliberately return the SDK's native promises. */
import type { AvailableInstallation } from "../../contracts/installation.js";
import type {
  ControlResult,
  RequestRecord,
  ResponseBody,
  Session,
  SessionOptions,
  StartSession,
} from "../../contracts/session.js";
import { sealSession } from "../seal-session.js";
import { createSessionKernel } from "../session-kernel.js";
import { createAcpClientApp } from "./client-app.js";
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
 *   session id it names — a foreign id is a derived child session (records.ts).
 * - vendor extension notifications the profile lists are recorded verbatim.
 * - runtime→app requests (permission, terminal) are toApp request records;
 *   oar's automatic answer is the matching `answered` response (client-app.ts).
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
    const args = typeof profile.args === "function" ? profile.args(options) : profile.args;
    const environment = { ...process.env, ...options.env };
    const terminalHost = createAcpTerminalHost(options.cwd, environment, {
      shellCommand: profile.terminalShellCommand === true,
    });
    // The recorder queues everything until the handshake reveals the session
    // id and the kernel can be bound (records.ts).
    const usageGate = createUsageUpdateGate();
    const recorder = createAcpRecorder(usageGate);
    const client = createAcpClientApp(terminalHost, {
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

    let disposed = false;
    let disposeRequest: RequestRecord | null = null;
    const turns = createAcpTurns({
      kernel,
      runtime,
      profile,
      usageGate,
      disposed: () => disposed,
    });
    // oxlint-disable-next-line promise/prefer-await-to-then, promise/always-return -- Exit observation outlives session creation.
    void runtime.exited.then((code) => {
      void terminalHost.dispose();
      // An outcome only oar observes: answers our dispose when we caused the
      // exit, stands alone (requestId "") when the runtime died on its own.
      kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code });
      turns.onExit();
    });

    const guarded = (
      decide: (request: RequestRecord) => ResponseBody | Promise<ResponseBody>,
    ): ((request: RequestRecord) => ResponseBody | Promise<ResponseBody>) =>
      (request) => (disposed ? { kind: "rejected", reason: "session disposed" } : decide(request));

    return sealSession({
      id: kernel.sessionId,
      capabilities: profile.capabilities,
      prompt: (input): Promise<ControlResult> => kernel.control({ kind: "prompt", input }, guarded((request): ResponseBody =>
        (turns.active() === null ? turns.begin(request, input) : { kind: "rejected", reason: "busy" }))),
      steer: (input): Promise<ControlResult> => kernel.control({ kind: "steer", input }, guarded((): ResponseBody | Promise<ResponseBody> => {
        const steerParams = profile.steerParams;
        if (steerParams === undefined) {
          return { kind: "rejected", reason: "not_steerable: runtime cannot inject into an active turn" };
        }
        const state = turns.active();
        return state === null
          ? { kind: "rejected", reason: "not_steerable: no active turn" }
          : turns.steer(state, input, steerParams(input));
      })),
      queue: (input): Promise<ControlResult> => kernel.control({ kind: "queue", input }, guarded(() => turns.hold(input))),
      abort: (): Promise<ControlResult> => kernel.control({ kind: "abort" }, guarded((): ResponseBody | Promise<ResponseBody> => {
        const state = turns.active();
        return state === null ? { kind: "rejected", reason: "no active turn" } : turns.abort(state);
      })),
      subscribe: (observer, cursor) => kernel.subscribe(observer, cursor),
      records: () => kernel.records(),
      graph: () => kernel.graph(),
      dispose: async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        disposeRequest = kernel.request("toRuntime", { kind: "dispose" });
        const state = turns.active();
        if (state !== null && !runtime.closed) {
          await turns.abort(state);
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
