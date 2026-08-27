import {
  methods,
  ndJsonStream,
  RequestError,
  type AgentNotificationMethod,
  type AgentNotificationParamsByMethod,
  type AgentRequestMethod,
  type AgentRequestParamsByMethod,
  type AgentRequestResponsesByMethod,
  type ClientConnection,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { spawnStreamProcess, type StreamProcess } from "../executable/index.js";
import type { JsonRecord } from "../json.js";
import {
  AcpError,
  acpProcessExitedError,
  acpRequestTimeoutError,
  acpRpcError,
} from "./errors.js";
import { createAcpSdkClient, type AcpSdkClientOptions } from "./sdk-client.js";

export { methods as acpMethods } from "@agentclientprotocol/sdk";

export interface AcpRequestOptions {
  /** Null disables the deadline for long-running requests such as session/prompt. */
  readonly timeoutMs?: number | null;
}

export interface AcpClientOptions extends AcpSdkClientOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
}

export interface AcpJsonRpcClient {
  readonly spawned: Promise<void>;
  readonly exited: Promise<number | null>;
  readonly closed: boolean;
  request<Method extends AgentRequestMethod>(
    method: Method,
    params: AgentRequestParamsByMethod[Method],
    options?: AcpRequestOptions,
  ): Promise<AgentRequestResponsesByMethod[Method]>;
  request<Response = JsonRecord>(
    method: string,
    params: unknown,
    options?: AcpRequestOptions,
  ): Promise<Response>;
  notify<Method extends AgentNotificationMethod>(
    method: Method,
    params: AgentNotificationParamsByMethod[Method],
  ): Promise<void>;
  notify(method: string, params: unknown): Promise<void>;
  onNotification(handler: (method: string, params: JsonRecord) => void): void;
  onExit(handler: (code: number | null) => void): void;
  kill(): void;
}

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

function mapRequestError(
  error: unknown,
  connectionClosed: boolean,
  exitCode: number | null,
): Error {
  if (error instanceof AcpError) {
    return error;
  }
  if (error instanceof RequestError) {
    return acpRpcError(error.code, error.message, error.data);
  }
  if (connectionClosed) {
    return acpProcessExitedError(exitCode);
  }
  return error instanceof Error ? error : new Error("ACP request failed");
}

/** Official-SDK-backed ACP v1 connection with OAR-owned process lifecycle. */
class SdkAcpJsonRpcClient implements AcpJsonRpcClient {
  readonly spawned: Promise<void>;
  readonly exited: Promise<number | null>;
  private readonly child: StreamProcess;
  private readonly connection: ClientConnection;
  private readonly requestTimeoutMs: number;
  private readonly notificationHandlers: ((method: string, params: JsonRecord) => void)[] = [];
  private readonly exitHandlers: ((code: number | null) => void)[] = [];
  private ended = false;
  private exitCode: number | null = null;

  constructor(command: string, args: readonly string[], options: AcpClientOptions) {
    this.child = spawnStreamProcess(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    this.spawned = this.child.spawned;
    this.exited = this.child.exited;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    const app = createAcpSdkClient(options, (method, params) => {
      for (const handler of this.notificationHandlers) {
        handler(method, params);
      }
    });
    // Node's stream/web declarations and TypeScript's DOM declarations model
    // the same WHATWG byte streams with incompatible generic constraints.
    // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Runtime values are the native WHATWG streams expected by the SDK.
    const output = Writable.toWeb(this.child.stdin) as Parameters<typeof ndJsonStream>[0];
    // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Runtime values are the native WHATWG streams expected by the SDK.
    const input = Readable.toWeb(this.child.stdout) as Parameters<typeof ndJsonStream>[1];
    this.connection = app.connect(ndJsonStream(output, input));
    this.child.onExit((code) => {
      this.ended = true;
      this.exitCode = code;
      this.connection.close(acpProcessExitedError(code));
      for (const handler of this.exitHandlers) {
        handler(code);
      }
    });
  }

  get closed(): boolean {
    return this.ended || this.connection.signal.aborted;
  }

  request<Method extends AgentRequestMethod>(
    method: Method,
    params: AgentRequestParamsByMethod[Method],
    options?: AcpRequestOptions,
  ): Promise<AgentRequestResponsesByMethod[Method]>;
  request<Response = JsonRecord>(
    method: string,
    params: unknown,
    options?: AcpRequestOptions,
  ): Promise<Response>;
  async request(
    method: string,
    params: unknown,
    options: AcpRequestOptions = {},
  ): Promise<unknown> {
    await this.spawned;
    if (this.closed) {
      throw acpProcessExitedError(this.exitCode);
    }
    const timeoutMs = options.timeoutMs === undefined ? this.requestTimeoutMs : options.timeoutMs;
    const controller = timeoutMs === null ? undefined : new AbortController();
    const requestOptions = controller === undefined
      ? undefined
      : { cancellationSignal: controller.signal };
    const sdkRequest = this.connection.agent.request(method, params, requestOptions);
    const limit = timeoutMs === null || controller === undefined
      ? undefined
      : deadline(method, timeoutMs, controller);
    try {
      const response = await (limit === undefined
        ? sdkRequest
        : Promise.race([sdkRequest, limit.promise]));
      if (method === methods.agent.session.prompt) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      return response;
    } catch (error) {
      if (!(error instanceof AcpError && error.kind === "timeout")) {
        await this.captureExit();
      }
      throw mapRequestError(error, this.closed, this.exitCode);
    } finally {
      if (limit !== undefined) {
        clearTimeout(limit.timer);
      }
    }
  }

  notify<Method extends AgentNotificationMethod>(
    method: Method,
    params: AgentNotificationParamsByMethod[Method],
  ): Promise<void>;
  notify(method: string, params: unknown): Promise<void>;
  async notify(method: string, params: unknown): Promise<void> {
    if (this.closed) {
      throw acpProcessExitedError(this.exitCode);
    }
    try {
      await this.connection.agent.notify(method, params);
    } catch (error) {
      await this.captureExit();
      throw mapRequestError(error, this.closed, this.exitCode);
    }
  }

  onNotification(handler: (method: string, params: JsonRecord) => void): void {
    this.notificationHandlers.push(handler);
  }

  onExit(handler: (code: number | null) => void): void {
    if (this.ended) {
      queueMicrotask(() => {
        handler(this.exitCode);
      });
    } else {
      this.exitHandlers.push(handler);
    }
  }

  kill(): void {
    if (!this.ended) {
      this.connection.close(acpProcessExitedError(null));
      this.child.kill();
    }
  }

  private async captureExit(): Promise<void> {
    if (this.connection.signal.aborted && !this.ended) {
      await this.exited;
    }
  }
}

/**
 * Private ACP v1 client backed by the official TypeScript SDK. The SDK owns
 * NDJSON, JSON-RPC, cancellation, schemas, and wire types; OAR owns the child.
 */
export function startAcpJsonRpcClient(
  command: string,
  args: readonly string[],
  options: AcpClientOptions = {},
): AcpJsonRpcClient {
  return new SdkAcpJsonRpcClient(command, args, options);
}
