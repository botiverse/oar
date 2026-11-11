// BYOK change: Modified from OAR 95c6547 so the caller owns the ACP process and its explicit environment (Apache-2.0).
import {
  ndJsonStream,
  RequestError,
  type ClientApp,
  type ClientConnection,
  type SendRequestOptions,
  type AnyMessage,
} from "@agentclientprotocol/sdk";
// BYOK change: no executable manager; the caller injects its owned JSONL process.
import { AcpError, acpProcessExitedError, acpRequestTimeoutError } from "./errors.js";
import { nativeErrorCause } from "../native-error.js";
import { observeAcpOpening, type AcpOpening } from "./opening.js";
import { acpEofInput, drainingAcpInput } from "./input.js";

export { client as createAcpClient, methods } from "@agentclientprotocol/sdk";
export type { ClientApp, SessionNotification } from "@agentclientprotocol/sdk";

interface Deadline {
  readonly promise: Promise<never>;
  readonly timer: NodeJS.Timeout;
}

function deadline(method: string, timeoutMs: number, controller: AbortController): Deadline {
  const { promise, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    controller.abort();
    reject(acpRequestTimeoutError(method, timeoutMs));
  }, timeoutMs);
  timer.unref();
  return { promise, timer };
}

function processClosed(process: AcpProcess): boolean {
  return process.closed;
}

// BYOK change: the injected line process the caller creates, adopts and reaps.
export interface AcpLineProcess {
  readonly spawned: Promise<void>;
  readonly exited: Promise<number | null>;
  /** One complete line; settles when stdin accepted it, rejects when the process failed. */
  writeAcknowledged(text: string): Promise<void>;
  onLine(handler: (line: string) => void): void;
  onExit(handler: (code: number | null) => void): void;
  kill(): void;
  /** Read the process table now and remember this process's descendants for its disposal; throws when the table cannot be read. */
  observeDescendants(): void;
}

// BYOK change: the caller passes the complete filtered environment; nothing ambient is merged.
export type SpawnAcpLineProcess = (
  command: string,
  args: readonly string[],
  options: { readonly env: Readonly<Record<string, string>>; readonly cwd?: string },
) => AcpLineProcess;

export interface AcpProcessOptions {
  /** Apply credential-operation policy before the SDK can log a malformed native message. */
  readonly incoming?: (message: AnyMessage) => AnyMessage | undefined;
  /** Observe request ids when an incoming filter must discard unsolicited responses. */
  readonly outgoing?: (message: AnyMessage) => void;
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>; // BYOK change: required explicit environment.
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
  readonly redact?: (text: string) => string;
  kill(): void;
  // BYOK change: no `resources` reader, native diagnostics or upstream shutdown/cancellation observation; the SDK process-tree authority owns the tree.
  /** BYOK change: the injected line process's synchronous descendant read, taken before a native cancel. */
  observeDescendants(): void;
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
): Promise<Response> {
  await process.spawned;
  if (processClosed(process)) {
    throw acpProcessExitedError(process.exitCode);
  }
  const controller = timeoutMs === null ? undefined : new AbortController();
  const limit = timeoutMs === null || controller === undefined
    ? undefined
    : deadline(method, timeoutMs, controller);
  try {
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
      throw acpProcessExitedError(process.exitCode);
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
  spawnLineProcess: SpawnAcpLineProcess, // BYOK change: caller-owned process.
  command: string,
  args: readonly string[],
  app: ClientApp,
  options: AcpProcessOptions,
): AcpProcess {
  const child = spawnLineProcess(command, args, { env: options.env, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
  // BYOK change: the owned process already splits stdout into bounded lines.
  // Each line goes back to ndJsonStream with its newline, so the SDK keeps
  // its own framing, parse-error answers and write ordering.
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // A closed connection cancels the reader; later lines and the exit are then dropped.
  let reading = true;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      child.onLine((line) => {
        if (reading) {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
      });
      child.onExit(() => {
        if (reading) {
          reading = false;
          controller.close();
        }
      });
    },
    cancel() {
      reading = false;
    },
  });
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      // ndJsonStream writes one whole encoded message per chunk.
      return child.writeAcknowledged(decoder.decode(chunk));
    },
  });
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
  // Normal EOF preserves the native shutdown lifetime; it never starts an
  // OAR cleanup on its own. The SDK process-tree owner reaps the child.
  const disconnected = (): void => { if (connection.signal.reason !== eof) { child.kill(); } };
  connection.signal.addEventListener("abort", disconnected, { once: true });
  if (connection.signal.aborted) { disconnected(); }
  let ended = false;
  let exitCode: number | null = null;
  child.onExit((code) => {
    ended = true;
    exitCode = code;
    connection.close(acpProcessExitedError(code));
  });
  return {
    connection,
    ...(options.redact === undefined ? {} : { redact: options.redact }),
    spawned: child.spawned,
    exited: child.exited,
    get closed() {
      return ended || connection.signal.aborted;
    },
    get exitCode() {
      return exitCode;
    },
    observeDescendants: () => { child.observeDescendants(); },
    kill() {
      if (!ended) {
        connection.close(acpProcessExitedError(null));
        child.kill();
      }
    },
  };
}
