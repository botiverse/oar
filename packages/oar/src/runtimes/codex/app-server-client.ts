import { spawnLineProcess } from "../../shared/executable/index.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";

/**
 * Minimal persistent JSON-RPC client over codex app-server's stdio JSONL
 * transport. Local to the codex runtime until a second consumer earns a
 * shared promotion; process mechanics live in shared/executable.
 */
/** How a request settled, delivered synchronously as the reply line is read. */
export type RpcOutcome =
  | { readonly kind: "result"; readonly result: JsonRecord }
  | { readonly kind: "error"; readonly error: Error };

export interface AppServerClient {
  readonly spawned: Promise<void>;
  readonly exited: Promise<number | null>;
  /**
   * Send a request. `onSettled`, when given, runs SYNCHRONOUSLY at the moment
   * the reply line (or the exit) is processed — before any later line in the
   * same chunk — so a caller can record the reply in stream order; the
   * returned promise settles afterwards, on the microtask queue.
   */
  request(method: string, params: JsonRecord, onSettled?: (outcome: RpcOutcome) => void): Promise<JsonRecord>;
  notify(method: string, params: JsonRecord): void;
  onNotification(handler: (method: string, params: JsonRecord) => void): void;
  /** A server-initiated request (a frame with both `id` and `method`): approvals, user input, dynamic tools. The client does not answer them. */
  onServerRequest(handler: (id: string, method: string, params: JsonRecord) => void): void;
  onExit(handler: (code: number | null) => void): void;
  kill(): void;
}

interface Pending {
  resolve(result: JsonRecord): void;
  reject(error: Error): void;
  settled(outcome: RpcOutcome): void;
}

export function startAppServerClient(
  command: string,
  env?: Readonly<Record<string, string>>,
  configOverrides: Readonly<Record<string, string>> = {},
): AppServerClient {
  // -c KEY=VALUE injects config at launch. This is the ONLY seam that reaches
  // codex's exec tool: thread/start.sandboxMode does not (pinned on a real
  // login — thread param honored for its own turns but exec follows config).
  const overrideArgs = Object.entries(configOverrides).flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  const child = spawnLineProcess(
    command,
    ["app-server", ...overrideArgs, "--listen", "stdio://"],
    env === undefined ? {} : { env: { ...process.env, ...env } },
  );
  const pending = new Map<number, Pending>();
  const notificationHandlers: ((method: string, params: JsonRecord) => void)[] = [];
  const serverRequestHandlers: ((id: string, method: string, params: JsonRecord) => void)[] = [];
  let nextId = 1;
  let exited = false;

  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message === null) {
      return;
    }
    const hasId = typeof message.id === "number" || typeof message.id === "string";
    if (typeof message.method === "string") {
      const params = asRecord(message.params) ?? {};
      if (hasId) {
        for (const handler of serverRequestHandlers) {
          handler(String(message.id), message.method, params);
        }
      } else {
        for (const handler of notificationHandlers) {
          handler(message.method, params);
        }
      }
      return;
    }
    if (typeof message.id === "number" && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      const error = asRecord(message.error);
      if (error !== null) {
        const failure = new Error(typeof error.message === "string" ? error.message : "app-server error");
        waiter?.settled({ kind: "error", error: failure });
        waiter?.reject(failure);
      } else {
        const result = asRecord(message.result) ?? {};
        waiter?.settled({ kind: "result", result });
        waiter?.resolve(result);
      }
    }
  });
  child.onExit(() => {
    exited = true;
    for (const waiter of pending.values()) {
      const error = new Error("app-server exited");
      waiter.settled({ kind: "error", error });
      waiter.reject(error);
    }
    pending.clear();
  });

  return {
    spawned: child.spawned,
    exited: child.exited,
    async request(method, params, onSettled) {
      const settled = onSettled ?? ((): void => {});
      if (exited) {
        const error = new Error("app-server exited");
        settled({ kind: "error", error });
        throw error;
      }
      const id = nextId;
      nextId += 1;
      // oxlint-disable-next-line promise/avoid-new -- settlement is driven by the response pump
      const result = await new Promise<JsonRecord>((resolve, reject) => {
        pending.set(id, { resolve, reject, settled });
        child.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      return result;
    },
    notify(method, params) {
      child.write(`${JSON.stringify({ method, params })}\n`);
    },
    onNotification(handler) {
      notificationHandlers.push(handler);
    },
    onServerRequest(handler) {
      serverRequestHandlers.push(handler);
    },
    onExit(handler) {
      child.onExit(handler);
    },
    kill() {
      child.kill();
    },
  };
}
