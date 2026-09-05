/* oxlint-disable typescript/promise-function-async -- SDK callbacks deliberately return the SDK's native promises. */
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { ContextUsage, Session, SessionOptions, StartSession, SteerResult, Turn, TurnOutcome } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../json.js";
import { sealSession } from "../seal-session.js";
import { createSessionKernel, type KernelTurn } from "../session-kernel.js";
import { AcpError, acpProcessExitedError } from "./errors.js";
import {
  closeAcpSession,
  createAcpModelReadback,
  createUsageUpdateGate,
  hasAcpCapability,
  openAcpSession,
  promptAcp,
  type AcpSessionProfile,
} from "./profile.js";
import { methods, startAcpProcess, type SessionNotification } from "./process.js";
import {
  acpFailureOutcome, acpRuntimeExitedOutcome, createAcpProjectionState,
  defaultAcpPromptOutcome, finishAcpTools, projectAcpUpdate,
  type AcpProjectionState,
} from "./projection.js";
import { createAcpClientApp, createAcpTerminalHost } from "./terminal.js";

export type { AcpSessionProfile } from "./profile.js";

interface ActiveTurn {
  readonly kernelTurn: KernelTurn;
  readonly outcomes: Map<number, TurnOutcome>;
  readonly pending: Set<number>;
  readonly projection: AcpProjectionState;
  abortRequested: boolean;
  latestRequest: number;
}

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
    // Watched from the first frame: kimi pushes its model config_option_update
    // before session/set_model is answered, i.e. before the session is open.
    const model = createAcpModelReadback();
    let receiveUpdate = (notification: SessionNotification): void => {
      model.observe(asRecord(notification.update));
    };
    const client = createAcpClientApp(terminalHost, (notification) => {
      receiveUpdate(notification);
    });
    const runtime = startAcpProcess(installation.command, args, client, { cwd: options.cwd, env: environment });
    const opened = await openAcpSession(runtime, profile, options).catch(async (error: unknown) => {
      runtime.kill();
      await runtime.exited;
      await terminalHost.dispose();
      throw error;
    });
    model.opened(opened);
    const capabilities = asRecord(opened.initialized.agentCapabilities);
    const sessionCapabilities = asRecord(capabilities?.sessionCapabilities);
    const supportsClose = hasAcpCapability(sessionCapabilities?.close);
    const kernel = createSessionKernel(opened.sessionId);
    const held: string[] = [];
    let active: ActiveTurn | null = null;
    let contextUsage: ContextUsage | null = null;
    const usageGate = createUsageUpdateGate();
    let nextRequest = 0;
    let disposed = false;
    let dead = false;
    const settle = (state: ActiveTurn, outcome: TurnOutcome): void => {
      if (state.kernelTurn.settled()) {
        return;
      }
      for (const body of finishAcpTools(state.projection)) {
        state.kernelTurn.emit(body);
      }
      state.kernelTurn.settle(outcome);
      if (active === state) {
        active = null;
      }
      queueMicrotask(drainHeld);
    };
    const failHeld = (): void => {
      while (held.length > 0) {
        held.shift();
        kernel.begin()?.settle({
          kind: "failed",
          reason: "ACP process exited before queued input could run",
          failure: "runtime_exited",
        });
      }
    };
    receiveUpdate = (notification): void => {
      if (notification.sessionId !== opened.sessionId) {
        return;
      }
      const update = asRecord(notification.update);
      if (update === null) {
        return;
      }
      model.observe(update);
      const state = active;
      const projected = projectAcpUpdate(state?.projection ?? createAcpProjectionState(), update);
      contextUsage = projected.contextUsage ?? contextUsage;
      usageGate.observe(projected.contextUsage);
      if (state !== null && !state.kernelTurn.settled()) {
        for (const body of projected.bodies) {
          state.kernelTurn.emit(body);
        }
      }
    };
    const finishRequest = (
      state: ActiveTurn,
      requestNumber: number,
      outcome: TurnOutcome,
    ): void => {
      if (state.kernelTurn.settled()) {
        return;
      }
      state.pending.delete(requestNumber);
      state.outcomes.set(requestNumber, outcome);
      if (state.pending.size === 0) {
        settle(state, state.outcomes.get(state.latestRequest) ?? outcome);
      }
    };
    const startVendorPrompt = (
      state: ActiveTurn,
      input: string,
      extraParams: JsonRecord = {},
    ): void => {
      nextRequest += 1;
      const requestNumber = nextRequest;
      state.latestRequest = requestNumber;
      state.pending.add(requestNumber);
      void (async (): Promise<void> => {
        try {
          usageGate.arm();
          const result = await promptAcp(runtime, opened.sessionId, input, extraParams);
          await usageGate.settleAfterPrompt(profile, state.abortRequested);
          contextUsage = profile.promptContextUsage?.(result) ?? contextUsage;
          finishRequest(
            state,
            requestNumber,
            profile.promptOutcome?.(result) ?? defaultAcpPromptOutcome(result),
          );
        } catch (error) {
          const outcome = state.abortRequested
            && !(error instanceof AcpError && error.kind === "process_exited")
            ? { kind: "aborted" as const }
            : acpFailureOutcome(error);
          finishRequest(state, requestNumber, outcome);
        }
      })();
    };
    const makeTurn = (state: ActiveTurn): Turn => {
      const steerParams = profile.steerParams;
      return {
        id: state.kernelTurn.id,
        outcome: state.kernelTurn.outcome,
        abort: async () => {
          if (state.kernelTurn.settled()) {
            return;
          }
          if (!state.abortRequested) {
            state.abortRequested = true;
            try {
              await runtime.connection.agent.notify(
                methods.agent.session.cancel,
                { sessionId: opened.sessionId },
              );
            } catch (error) {
              settle(state, acpFailureOutcome(error));
            }
          }
          const timeoutMs = profile.abortTimeoutMs ?? 10_000;
          const fallback = setTimeout(() => {
            if (!state.kernelTurn.settled()) {
              dead = true;
              settle(state, { kind: "aborted" });
              runtime.kill();
            }
          }, timeoutMs);
          fallback.unref();
          await state.kernelTurn.outcome;
          clearTimeout(fallback);
        },
        ...(steerParams === undefined ? {} : {
          steer: async (input: string): Promise<SteerResult> => {
            await runtime.spawned;
            if (state.kernelTurn.settled() || active !== state) {
              return {
                kind: "not_steerable" as const,
                reason: "turn already ended",
              };
            }
            if (runtime.closed) {
              throw acpProcessExitedError(runtime.exitCode);
            }
            startVendorPrompt(state, input, steerParams(input));
            return { kind: "accepted" as const };
          },
        }),
      };
    };
    const beginInput = (input: string): Turn | null => {
      const kernelTurn = kernel.begin();
      if (kernelTurn === null) {
        return null;
      }
      const state: ActiveTurn = {
        kernelTurn,
        outcomes: new Map(),
        pending: new Set(),
        projection: createAcpProjectionState(),
        abortRequested: false,
        latestRequest: 0,
      };
      active = state;
      if (dead || runtime.closed) {
        settle(state, acpRuntimeExitedOutcome(null));
      } else {
        startVendorPrompt(state, input);
      }
      return makeTurn(state);
    };
    function drainHeld(): void {
      if (disposed || active !== null) {
        return;
      }
      if (dead || runtime.closed) {
        failHeld();
        return;
      }
      const input = held.shift();
      if (input !== undefined) {
        beginInput(input);
      }
    }
    const onRuntimeExit = (code: number | null): void => {
      void terminalHost.dispose();
      if (disposed) {
        return;
      }
      dead = true;
      if (active !== null) {
        settle(active, acpRuntimeExitedOutcome(code));
      }
      failHeld();
    };
    // oxlint-disable-next-line promise/prefer-await-to-then, promise/always-return -- Exit observation outlives session creation.
    void runtime.exited.then(onRuntimeExit);
    return sealSession({
      id: kernel.sessionId,
      prompt(input) {
        const next = beginInput(input);
        return next === null ? { kind: "busy" } : { kind: "turn", turn: next };
      },
      subscribe: (observer) => kernel.subscribe(observer),
      contextUsage: () => contextUsage,
      model: model.current,
      queue: {
        durable: false,
        add: async (input): Promise<void> => {
          await runtime.spawned;
          if (disposed || dead || runtime.closed) {
            throw acpProcessExitedError(runtime.exitCode);
          }
          held.push(input);
          queueMicrotask(drainHeld);
        },
      },
      dispose: async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        held.splice(0);
        if (active !== null && !active.kernelTurn.settled()) {
          try {
            await runtime.connection.agent.notify(methods.agent.session.cancel, { sessionId: opened.sessionId });
          } catch {
            // Local settlement below is authoritative during disposal.
          }
          settle(active, { kind: "aborted" });
        }
        if (supportsClose && !runtime.closed) {
          await closeAcpSession(runtime, opened.sessionId).catch(() => {});
        }
        runtime.kill();
        await runtime.exited;
        await terminalHost.dispose();
      },
    });
  };
}
