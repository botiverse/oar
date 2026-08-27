import type { AvailableInstallation } from "../../contracts/installation.js";
import type { ContextUsage, Session, SessionOptions, StartSession, SteerResult, Turn, TurnOutcome } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../json.js";
import { sealSession } from "../seal-session.js";
import { createSessionKernel, type KernelTurn } from "../session-kernel.js";
import { AcpError, acpProcessExitedError } from "./errors.js";
import { acpMethods as methods, startAcpJsonRpcClient } from "./json-rpc.js";
import {
  defaultAcpReverseRequest,
  hasAcpCapability,
  openAcpSession,
  type AcpSessionProfile,
} from "./profile.js";
import {
  acpFailureOutcome, acpRuntimeExitedOutcome, createAcpProjectionState,
  defaultAcpPromptOutcome, finishAcpTools, projectAcpUpdate,
  type AcpProjectionState,
} from "./projection.js";
import { createAcpTerminalHost } from "./terminal.js";

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
    const client = startAcpJsonRpcClient(installation.command, args, {
      cwd: options.cwd,
      env: environment,
      ...(profile.requestTimeoutMs === undefined ? {} : {
        requestTimeoutMs: profile.requestTimeoutMs,
      }),
      reverseRequest: (method, params): JsonRecord | Promise<JsonRecord> => {
        if (terminalHost.handles(method)) {
          return terminalHost.request(method, params);
        }
        return profile.reverseRequest === undefined
          ? defaultAcpReverseRequest(method, params)
          : profile.reverseRequest(method, params);
      },
    });
    const opened = await openAcpSession(client, profile, options).catch(async (error: unknown) => {
      client.kill();
      await client.exited;
      await terminalHost.dispose();
      throw error;
    });
    const capabilities = asRecord(opened.initialized.agentCapabilities);
    const sessionCapabilities = asRecord(capabilities?.sessionCapabilities);
    const supportsClose = hasAcpCapability(sessionCapabilities?.close);
    const kernel = createSessionKernel(opened.sessionId);
    const held: string[] = [];
    let active: ActiveTurn | null = null;
    let contextUsage: ContextUsage | null = null;
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
    client.onNotification((method, params) => {
      if (method !== methods.client.session.update || params.sessionId !== opened.sessionId) {
        return;
      }
      const update = asRecord(params.update);
      if (update === null) {
        return;
      }
      const state = active;
      const projected = projectAcpUpdate(
        state?.projection ?? createAcpProjectionState(),
        update,
      );
      contextUsage = projected.contextUsage ?? contextUsage;
      if (state !== null && !state.kernelTurn.settled()) {
        for (const body of projected.bodies) {
          state.kernelTurn.emit(body);
        }
      }
    });
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
          const result = await client.request(methods.agent.session.prompt, {
            sessionId: opened.sessionId,
            prompt: [{ type: "text", text: input }],
            ...extraParams,
          }, { timeoutMs: null });
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
              await client.notify(methods.agent.session.cancel, { sessionId: opened.sessionId });
            } catch (error) {
              settle(state, acpFailureOutcome(error));
            }
          }
          const timeoutMs = profile.abortTimeoutMs ?? 10_000;
          const fallback = setTimeout(() => {
            if (!state.kernelTurn.settled()) {
              dead = true;
              settle(state, { kind: "aborted" });
              client.kill();
            }
          }, timeoutMs);
          fallback.unref();
          await state.kernelTurn.outcome;
          clearTimeout(fallback);
        },
        ...(steerParams === undefined ? {} : {
          steer: async (input: string): Promise<SteerResult> => {
            await client.spawned;
            if (state.kernelTurn.settled() || active !== state) {
              return {
                kind: "not_steerable" as const,
                reason: "turn already ended",
              };
            }
            if (client.closed) {
              throw acpProcessExitedError(null);
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
      if (dead || client.closed) {
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
      if (dead || client.closed) {
        failHeld();
        return;
      }
      const input = held.shift();
      if (input !== undefined) {
        beginInput(input);
      }
    }
    client.onExit((code) => {
      void terminalHost.dispose();
      if (disposed) {
        return;
      }
      dead = true;
      if (active !== null) {
        settle(active, acpRuntimeExitedOutcome(code));
      }
      failHeld();
    });
    return sealSession({
      id: kernel.sessionId,
      prompt(input) {
        const next = beginInput(input);
        return next === null ? { kind: "busy" } : { kind: "turn", turn: next };
      },
      subscribe: (observer) => kernel.subscribe(observer),
      contextUsage: () => contextUsage,
      queue: {
        durable: false,
        add: async (input): Promise<void> => {
          await client.spawned;
          if (disposed || dead || client.closed) {
            throw acpProcessExitedError(null);
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
            await client.notify(methods.agent.session.cancel, { sessionId: opened.sessionId });
          } catch {
            // Local settlement below is authoritative during disposal.
          }
          settle(active, { kind: "aborted" });
        }
        if (supportsClose && !client.closed) {
          await client.request(
            methods.agent.session.close,
            { sessionId: opened.sessionId },
            { timeoutMs: 2000 },
          ).catch(() => {});
        }
        client.kill();
        await client.exited;
        await terminalHost.dispose();
      },
    });
  };
}
