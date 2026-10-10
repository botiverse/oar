/* oxlint-disable import/max-dependencies -- Session assembly wires the environment, process, terminal host, recorder and control machinery. */
import { sessionEnvironment } from "../environment.js";
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
import { withSessionCredentials } from "../session-credentials.js";
import { createAcpClientApp } from "./client-app.js";
import {
  acpMcpOpenGuard,
  closeAcpSession,
  createUsageUpdateGate,
  openAcpSession,
  type AcpSessionProfile,
} from "./profile.js";
import { acpLaunchArgs } from "./launch-args.js";
import { startAcpProcess } from "./process.js";
import { createAcpRecorder } from "./records.js";
import { createAcpTerminalHost } from "./terminal.js";
import { acpTakesImages, createAcpTurns } from "./turns.js";
import { createAcpTokenUsage } from "./token-usage.js";

export type { AcpSessionProfile } from "./profile.js";

/*
 * ACP mapping onto the record stream (shared by grok and kimi; profiles carry the vendor bits):
 * - every `session/update` is ONE event record, native verbatim, for WHATEVER
 *   session id it names: a foreign id is a derived child session (records.ts).
 * - listed vendor notifications are recorded verbatim except credential redaction.
 * - runtime→app requests (permission, terminal) are toApp request records;
 *   oar's automatic answer is the matching `answered` response (client-app.ts).
 * - prompt / steer / queue / withdraw / abort / dispose are toRuntime requests answered
 *   accepted-or-rejected; the turn's end is the runtime's own prompt answer
 *   (turns.ts) or the process exit oar observed (`exited` response).
 */

export function acpSession(profile: AcpSessionProfile): StartSession {
  return withSessionCredentials(async (installation: AvailableInstallation, options: SessionOptions, credentials): Promise<Session> => {
    if (installation.via !== "executable") {
      throw new Error("ACP runtimes require an executable installation");
    }
    profile.validateOptions?.(options);
    // SessionOptions.mcpServers go out in the open request (mcp-servers.ts):
    // a list with an empty or repeated name fails before anything starts,
    // and an open that fails reports no credential they carry.
    const withoutCredentials = acpMcpOpenGuard(options.mcpServers, credentials.redact);
    const args = acpLaunchArgs(profile, options);
    const environment = sessionEnvironment(options.env);
    const terminalHost = createAcpTerminalHost(options.cwd, environment, {
      shellCommand: profile.terminalShellCommand === true,
    });
    // The recorder queues everything until the handshake reveals the session
    // id and the kernel can be bound (records.ts).
    const usageGate = createUsageUpdateGate();
    const tokenUsage = createAcpTokenUsage(profile);
    const recorder = createAcpRecorder(usageGate, profile.attributeUpdate, tokenUsage);
    const client = createAcpClientApp(terminalHost, {
      update: (notification) => {
        recorder.update(notification);
      },
      extension: (method, params) => {
        recorder.extension(method, profile.redactExtensionNotification?.(method, params) ?? params);
      },
      requested: (id, method, params) => {
        recorder.requested(id, method, params);
      },
      answered: (id, reply) => {
        recorder.answered(id, reply);
      },
      extensionNotifications: profile.extensionNotifications ?? [],
    });
    const runtime = startAcpProcess(installation.command, args, client, { cwd: options.cwd, env: environment, redact: credentials.redact });
    const opened = await openAcpSession(runtime, profile, options, (step) => {
      recorder.step(step.method, step.response);
    }).catch(async (error: unknown) => {
      runtime.kill();
      await runtime.exited;
      await terminalHost.dispose();
      throw withoutCredentials(error);
    });
    const kernel = credentials.kernel(opened.sessionId);
    recorder.bind(kernel);

    let disposeRequest: RequestRecord | null = null;
    const capabilities = { ...profile.capabilities, images: profile.capabilities.images ?? acpTakesImages(opened.initialized) };
    const turns = createAcpTurns({ kernel, runtime, profile, usageGate, capabilities, promptUsage: (result) => tokenUsage.prompt(result) });
    // oxlint-disable-next-line promise/prefer-await-to-then, promise/always-return -- Exit observation outlives session creation.
    void runtime.exited.then((code) => {
      void terminalHost.dispose();
      // An outcome only oar observes: answers our dispose when we caused the
      // exit, stands alone (requestId "") when the runtime died on its own.
      kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code });
      turns.onExit();
    });

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

    // A profile without steer params cannot inject, so the session has no `steer`.
    const { steerParams } = profile;
    const steer = steerParams === undefined
      ? {}
      : {
        steer: (input: string, inputOptions?: InputOptions): Promise<ControlResult> => control({ kind: "steer", input, ...inputOptions }, (): ResponseBody | Promise<ResponseBody> => {
          const state = turns.active();
          return state === null
            ? { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" }
            : turns.steer(state, input, inputOptions, steerParams(input));
        }),
      };

    return credentials.seal({
      id: kernel.sessionId,
      capabilities,
      prompt: (input, inputOptions?: InputOptions): Promise<ControlResult> => control({ kind: "prompt", input, ...inputOptions }, (request): ResponseBody =>
        (turns.active() === null ? turns.begin(request, input, inputOptions?.images) : { kind: "rejected", code: "busy", reason: "busy" })),
      ...steer,
      queue: (input, inputOptions?: InputOptions): Promise<ControlResult> => control({ kind: "queue", input, ...inputOptions }, () => turns.hold(input, inputOptions?.images, inputOptions?.inputId)),
      // The queue is held here (turns.ts), not by the vendor: an entry can be taken back until the drain sends it.
      withdraw: (inputId: string): Promise<ControlResult> => control({ kind: "withdraw", inputId }, () => turns.withdraw(inputId)),
      abort: (): Promise<ControlResult> => control({ kind: "abort" }, (): ResponseBody | Promise<ResponseBody> => {
        const state = turns.active();
        return state === null ? { kind: "rejected", code: "no_active_turn", reason: "no active turn" } : turns.abort(state);
      }),
      rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
      records: () => kernel.records(),
      graph: () => kernel.graph(),
      resources: runtime.resources,
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
        }
        if (opened.supportsClose && !runtime.closed) {
          await closeAcpSession(runtime, kernel.sessionId).catch(() => {});
        }
        runtime.kill();
        await runtime.exited;
        await terminalHost.dispose();
      },
    });
  });
}
