import {
  ndJsonStream,
  RequestError,
  type ClientApp,
  type ClientConnection,
  type SendRequestOptions,
  type AnyMessage,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { spawnLineProcess } from "../executable/index.js";
import type { CancellationObservation } from "../executable/process-cancellation.js";
import type { ProcessDiagnostics } from "../executable/diagnostics.js";
import { AcpError, acpProcessExitedError, acpRequestTimeoutError } from "./errors.js";
import { nativeErrorCause } from "../native-error.js";
import type { SessionResources } from "../../contracts/session.js";
import { observeAcpOpening, type AcpOpening } from "./opening.js";
import { acpEofInput, drainingAcpInput } from "./input.js";

export { client as createAcpClient, methods } from "@agentclientprotocol/sdk";
export type { ClientApp, SessionNotification } from "@agentclientprotocol/sdk";

interface Deadline {
  readonly promise: Promise<never>;
  readonly timer: NodeJS.Timeout;
}

function deadline(method: string, timeoutMs: number, controller: AbortController, startedAt?: number): Deadline {
  const { promise, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    controller.abort();
    reject(acpRequestTimeoutError(method, timeoutMs));
  }, startedAt === undefined ? timeoutMs : Math.max(0, timeoutMs - (performance.now() - startedAt)));
  timer.unref();
  return { promise, timer };
}

function processClosed(process: AcpProcess): boolean {
  return process.closed;
}

export interface AcpProcessOptions {
  /** Apply credential-operation policy before the SDK can log a malformed native message. */
  readonly incoming?: (message: AnyMessage) => AnyMessage | undefined;
  /** Observe request ids when an incoming filter must discard unsolicited responses. */
  readonly outgoing?: (message: AnyMessage) => void;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Only session processes publish exit observations. Shared stderr belongs to the process diagnostic sink. */
  readonly sessionExit?: "isolated" | ((diagnostics: ProcessDiagnostics) => void);
  /** Authentication queries keep all native diagnostics private. */
  readonly inheritStderr?: boolean;
  /** Session MCP credentials must not appear in protocol error messages, data or causes. */
  readonly redact?: (text: string) => string;
  /** Track notification arrival relative to the native session-open answer. */
  readonly opening?: AcpOpening;
}

/** A child process connected directly to an official SDK client app. */
export interface AcpProcess {
  readonly pid?: number;
  readonly connection: ClientConnection;
  readonly spawned: Promise<void>;
  readonly exited: Promise<number | null>;
  readonly closed: boolean;
  readonly exitCode: number | null;
  readonly exitError?: () => AcpError | undefined;
  readonly redact?: (text: string) => string;
  kill(): void;
  /** Only immediately before stopping: memoizes capture before native cancel/close can orphan tools. */
  prepareShutdown(): Promise<void>;
  /** Record the actual native stop attempt, immediately before sending cancel/close. */
  markNativeStop(): void;
  /** Observe before isolated user cancellation; never use for a shared root. */
  observeCancellation(): Promise<CancellationObservation>;
  /** Bounded native diagnostics for session error reporting. */
  diagnostics(): ProcessDiagnostics;
  /** The agent's memory with everything it started (`LineProcess.resources`). */
  readonly resources: () => Promise<SessionResources | null>;
}

/**
 * Add OAR's deadline and process-exit semantics around one direct SDK request.
 * A null timeout is for prompts, whose lifetime is controlled by cancel.
 */
export async function withAcpDeadline<Response>(
  process: AcpProcess,
  method: string,
  timeoutMs: number | null,
  send: (options?: SendRequestOptions) => Promise<Response>,
  startedAt?: number,
): Promise<Response> {
  // A startup gate supplies the original clock so queue and spawn use this same budget.
  if (startedAt === undefined) {
    await process.spawned;
    if (processClosed(process)) { throw process.exitError?.() ?? acpProcessExitedError(process.exitCode); }
  }
  const controller = timeoutMs === null ? undefined : new AbortController();
  const limit = timeoutMs === null || controller === undefined
    ? undefined
    : deadline(method, timeoutMs, controller, startedAt);
  try {
    if (startedAt !== undefined) {
      await (limit === undefined ? process.spawned : Promise.race([process.spawned, limit.promise]));
      if (timeoutMs !== null && performance.now() - startedAt >= timeoutMs) { throw acpRequestTimeoutError(method, timeoutMs); }
      if (processClosed(process)) { throw process.exitError?.() ?? acpProcessExitedError(process.exitCode); }
    }
    const request = send(controller === undefined
      ? undefined
      : { cancellationSignal: controller.signal });
    return await (limit === undefined ? request : Promise.race([request, limit.promise]));
  } catch (error) {
    if (error instanceof AcpError && error.kind === "timeout") {
      throw error;
    }
    if (processClosed(process)) {
      await process.exited;
      throw process.exitError?.() ?? acpProcessExitedError(process.exitCode);
    }
    if (error instanceof RequestError) {
      const redact = process.redact ?? ((text: string): string => text);
      const cause = nativeErrorCause(method, error.toErrorResponse(), redact);
      // Keep the SDK class/code for ACP's auth/model classification, but no
      // unredacted `data` or original error may remain down the cause chain.
      const failure = new RequestError(error.code, redact(error.message), cause.native.data);
      // Match ErrorOptions.cause: diagnostic context is not an enumerable
      // native error field, so existing error-frame projections stay intact.
      Object.defineProperty(failure, "cause", { value: cause, configurable: true, writable: true });
      throw failure;
    }
    throw error;
  } finally {
    if (limit !== undefined) {
      clearTimeout(limit.timer);
    }
  }
}

/** Spawn a stdio ACP agent and let the official SDK own the wire protocol. */
export function startAcpProcess(
  command: string,
  args: readonly string[],
  app: ClientApp,
  options: AcpProcessOptions = {},
): AcpProcess {
  const child = spawnLineProcess(command, args, { ...options, killTree: true });
  // Node and TypeScript model the same WHATWG byte streams with incompatible
  // generic constraints.
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Native WHATWG stream expected by the SDK.
  const output = Writable.toWeb(child.stdin) as Parameters<typeof ndJsonStream>[0];
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Native WHATWG stream expected by the SDK.
  const input = Readable.toWeb(child.stdout) as Parameters<typeof ndJsonStream>[1];
  const nativeStream = ndJsonStream(output, drainingAcpInput(input));
  const incoming = options.incoming;
  const writer = options.outgoing === undefined ? undefined : nativeStream.writable.getWriter();
  const stream = incoming === undefined && writer === undefined ? nativeStream : {
    writable: writer === undefined ? nativeStream.writable : new WritableStream<AnyMessage>({
      async write(message): Promise<void> { options.outgoing?.(message); await writer.write(message); },
      async close(): Promise<void> { await writer.close(); },
      async abort(reason: unknown): Promise<void> { await writer.abort(reason); },
    }),
    readable: incoming === undefined ? nativeStream.readable : nativeStream.readable.pipeThrough(new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller): void {
        const projected = incoming(message);
        if (projected !== undefined) { controller.enqueue(projected); }
      },
    })),
  };
  const observed = options.opening === undefined ? stream : observeAcpOpening(stream, options.opening);
  const { readable, eof } = acpEofInput(observed.readable);
  const connection = app.connect({ writable: observed.writable, readable });
  // A protocol or stream failure can close the SDK without a host dispose.
  // Draining stdout must not leave that disconnected agent running forever.
  // Normal EOF preserves the native shutdown lifetime, including hooks that
  // continue after stdout closes. It never starts an OAR cleanup on its own.
  const disconnected = (): void => { if (connection.signal.reason !== eof) { child.kill(); } };
  connection.signal.addEventListener("abort", disconnected, { once: true });
  if (connection.signal.aborted) { disconnected(); }
  let ended = false;
  let plannedStop = false;
  let exitError: AcpError | undefined = undefined;
  let exitCode: number | null = null;
  child.onExit((code) => {
    ended = true;
    exitCode = code;
    if (options.sessionExit !== undefined && !plannedStop && (options.sessionExit !== "isolated" || !child.stopping())) {
      const diagnostic = child.diagnostics();
      if (options.sessionExit === "isolated") {
        exitError = acpProcessExitedError(code, diagnostic, options.redact);
      } else {
        options.sessionExit(diagnostic);
        exitError = acpProcessExitedError(code, { exitCode: code, signal: diagnostic.signal, stderr: "" });
      }
    }
    connection.close(exitError ?? acpProcessExitedError(code));
    // Final cleanup is complete. An unobserved descendant may still hold the
    // pipe, but must not keep the cancelled raw-byte drain or the host alive.
    child.stdout.destroy();
  });
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    connection,
    ...(options.redact === undefined ? {} : { redact: options.redact }),
    spawned: child.spawned,
    exited: child.exited,
    exitError: () => exitError,
    get closed() {
      return ended || connection.signal.aborted;
    },
    get exitCode() {
      return exitCode;
    },
    kill() {
      if (!ended) {
        connection.close(acpProcessExitedError(null));
        child.kill();
      }
    },
    prepareShutdown: async () => { await child.prepareShutdown(); },
    markNativeStop: () => { plannedStop = true; child.markNativeStop(); },
    observeCancellation: async () => { const observation = await child.observeCancellation(); return observation; },
    resources: child.resources,
    diagnostics: () => child.diagnostics(),
  };
}
