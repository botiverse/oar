import { spawnLineProcess } from "../executable/index.js";
import { asRecord, parseJson, type JsonRecord } from "../json.js";
import {
  AcpError,
  acpProcessExitedError,
  acpProtocolError,
  acpRequestTimeoutError,
  acpRpcError,
} from "./errors.js";

type RpcId = number | string;

export interface AcpRequestOptions {
  /** Null disables the deadline for long-running requests such as session/prompt. */
  readonly timeoutMs?: number | null;
}

export interface AcpClientOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly reverseRequest?: (method: string, params: JsonRecord) => JsonRecord | Promise<JsonRecord>;
}

export interface AcpJsonRpcClient {
  readonly spawned: Promise<void>;
  readonly exited: Promise<number | null>;
  readonly closed: boolean;
  request(method: string, params: JsonRecord, options?: AcpRequestOptions): Promise<JsonRecord>;
  notify(method: string, params: JsonRecord): void;
  onNotification(handler: (method: string, params: JsonRecord) => void): void;
  onExit(handler: (code: number | null) => void): void;
  kill(): void;
}

interface PendingRequest {
  readonly resolve: (result: JsonRecord) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: NodeJS.Timeout;
}

function errorMessage(value: unknown): string {
  const error = asRecord(value);
  return typeof error?.message === "string" && error.message.trim().length > 0
    ? error.message
    : "ACP request failed";
}

function rpcId(value: unknown): RpcId | null {
  return typeof value === "number" || typeof value === "string" ? value : null;
}

/**
 * Private ACP v1 transport: newline-delimited JSON-RPC 2.0 over a child
 * process. Runtime identities and compatibility policy belong in the thin
 * profiles above this mechanism.
 */
export function startAcpJsonRpcClient(
  command: string,
  args: readonly string[],
  options: AcpClientOptions = {},
): AcpJsonRpcClient {
  const child = spawnLineProcess(command, args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const pending = new Map<RpcId, PendingRequest>();
  const notificationHandlers: ((method: string, params: JsonRecord) => void)[] = [];
  const exitHandlers: ((code: number | null) => void)[] = [];
  let nextId = 1;
  let ended = false;
  let exitCode: number | null = null;
  let terminalError: Error | null = null;

  const write = (message: JsonRecord): void => {
    if (ended) {
      throw terminalError ?? acpProcessExitedError(null);
    }
    child.write(`${JSON.stringify(message)}\n`);
  };

  const rejectPending = (error: Error): void => {
    terminalError ??= error;
    for (const waiter of pending.values()) {
      if (waiter.timer !== undefined) {
        clearTimeout(waiter.timer);
      }
      waiter.reject(error);
    }
    pending.clear();
  };

  const failProtocol = (message: string): void => {
    if (!ended) {
      rejectPending(acpProtocolError(message));
      child.kill();
    }
  };

  const replyToReverseRequest = async (
    id: RpcId,
    method: string,
    params: JsonRecord,
  ): Promise<void> => {
    try {
      if (options.reverseRequest === undefined) {
        throw acpRpcError(-32_601, `ACP client method not found: ${method}`);
      }
      const result = await options.reverseRequest(method, params);
      write({ jsonrpc: "2.0", id, result: asRecord(result) ?? {} });
    } catch (error) {
      const rpcError = error instanceof AcpError && error.kind === "rpc"
        ? error
        : acpRpcError(-32_603, "ACP client request failed");
      try {
        write({
          jsonrpc: "2.0",
          id,
          error: {
            code: rpcError.code,
            message: rpcError.message,
            ...(rpcError.data === undefined ? {} : { data: rpcError.data }),
          },
        });
      } catch {
        // The process exited while the reverse request was being handled.
      }
    }
  };

  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message === null) {
      failProtocol("ACP process emitted invalid JSON");
      return;
    }
    const id = rpcId(message.id);
    const method = typeof message.method === "string" ? message.method : null;
    if (id !== null && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const waiter = pending.get(id);
      if (waiter === undefined) {
        return;
      }
      pending.delete(id);
      if (waiter.timer !== undefined) {
        clearTimeout(waiter.timer);
      }
      const error = asRecord(message.error);
      if (error !== null) {
        const code = typeof error.code === "number" ? error.code : -32_603;
        waiter.reject(acpRpcError(code, errorMessage(error), error.data));
      } else {
        waiter.resolve(asRecord(message.result) ?? {});
      }
      return;
    }
    if (id !== null && method !== null) {
      void replyToReverseRequest(id, method, asRecord(message.params) ?? {});
      return;
    }
    if (id === null && method !== null) {
      const params = asRecord(message.params) ?? {};
      for (const handler of notificationHandlers) {
        handler(method, params);
      }
      return;
    }
    failProtocol("ACP process emitted an invalid JSON-RPC message");
  });

  child.onExit((code) => {
    ended = true;
    exitCode = code;
    rejectPending(terminalError ?? acpProcessExitedError(code));
    for (const handler of exitHandlers) {
      handler(code);
    }
  });

  return {
    spawned: child.spawned,
    exited: child.exited,
    get closed() {
      return ended;
    },
    async request(method, params, requestOptions = {}): Promise<JsonRecord> {
      const id = nextId;
      nextId += 1;
      const timeoutMs = requestOptions.timeoutMs === undefined
        ? (options.requestTimeoutMs ?? 15_000)
        : requestOptions.timeoutMs;
      // oxlint-disable-next-line promise/avoid-new -- settlement is driven by the response pump
      const promise = new Promise<JsonRecord>((resolve, reject) => {
        const timer = timeoutMs === null
          ? undefined
          : setTimeout(() => {
              pending.delete(id);
              try {
                write({
                  jsonrpc: "2.0",
                  method: "$/cancel_request",
                  params: { requestId: id },
                });
              } catch {
                // The exit path already rejected everything still pending.
              }
              reject(acpRequestTimeoutError(method, timeoutMs));
            }, timeoutMs);
        timer?.unref();
        pending.set(id, {
          resolve,
          reject,
          ...(timer === undefined ? {} : { timer }),
        });
        try {
          write({ jsonrpc: "2.0", id, method, params });
        } catch (error) {
          pending.delete(id);
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          reject(error instanceof Error ? error : new Error("ACP request write failed"));
        }
      });
      // oxlint-disable-next-line typescript/return-await -- `request` must be async by policy while settlement is pump-driven.
      return await promise;
    },
    notify(method, params) {
      write({ jsonrpc: "2.0", method, params });
    },
    onNotification(handler) {
      notificationHandlers.push(handler);
    },
    onExit(handler) {
      if (ended) {
        queueMicrotask(() => {
          handler(exitCode);
        });
      } else {
        exitHandlers.push(handler);
      }
    },
    kill() {
      if (!ended) {
        child.kill();
      }
    },
  };
}
