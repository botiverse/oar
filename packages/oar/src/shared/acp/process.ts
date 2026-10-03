import {
  ndJsonStream,
  type ClientApp,
  type ClientConnection,
  type SendRequestOptions,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { spawnLineProcess } from "../executable/index.js";
import { AcpError, acpProcessExitedError, acpRequestTimeoutError } from "./errors.js";

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

export interface AcpProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** A child process connected directly to an official SDK client app. */
export interface AcpProcess {
  readonly connection: ClientConnection;
  readonly spawned: Promise<void>;
  readonly exited: Promise<number | null>;
  readonly closed: boolean;
  readonly exitCode: number | null;
  kill(): void;
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
  const child = spawnLineProcess(command, args, options);
  // Node and TypeScript model the same WHATWG byte streams with incompatible
  // generic constraints.
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Native WHATWG stream expected by the SDK.
  const output = Writable.toWeb(child.stdin) as Parameters<typeof ndJsonStream>[0];
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Native WHATWG stream expected by the SDK.
  const input = Readable.toWeb(child.stdout) as Parameters<typeof ndJsonStream>[1];
  const connection = app.connect(ndJsonStream(output, input));
  let ended = false;
  let exitCode: number | null = null;
  child.onExit((code) => {
    ended = true;
    exitCode = code;
    connection.close(acpProcessExitedError(code));
  });
  return {
    connection,
    spawned: child.spawned,
    exited: child.exited,
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
  };
}
