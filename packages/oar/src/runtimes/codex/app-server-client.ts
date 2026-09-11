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

export interface AppServerHandlers {
  readonly onNotification: (method: string, params: JsonRecord) => void;
  readonly onServerRequest: (id: string, method: string, params: JsonRecord) => void;
}

export interface AppServerClient {
  readonly spawned: Promise<void>;
  readonly exited: Promise<number | null>;
  /**
   * Send a request. `onSettled`, when given, runs SYNCHRONOUSLY at the moment
   * the reply line (or the exit) is processed, before any later line in the
   * same chunk, so a caller can record the reply in stream order; the
   * returned promise settles afterwards, on the microtask queue.
   */
  request(method: string, params: JsonRecord, onSettled?: (outcome: RpcOutcome) => void): Promise<JsonRecord>;
  notify(method: string, params: JsonRecord): void;
  /**
   * Register the inbound handlers, once. Notifications and server-initiated
   * requests (frames with both `id` and `method`: approvals, user input,
   * dynamic tools; the client does not answer them) that arrive before this
   * call (the app-server talks right after `initialize`, before the thread
   * exists) are held in ONE queue and delivered here synchronously, in wire
   * order across both kinds: nothing the server said is lost or reordered
   * by registration timing.
   */
  handle(handlers: AppServerHandlers): void;
  /**
   * Place a callback in wire order: while frames are still being held (before
   * `handle`) it joins the held queue and runs at flush, after every frame
   * read before it and before every frame read after; once released it runs
   * immediately. Called from a request's synchronous `onSettled`, it pins a
   * record exactly where the reply sat on the wire.
   */
  mark(callback: () => void): void;
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
  // login: thread param honored for its own turns but exec follows config).
  const overrideArgs = Object.entries(configOverrides).flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  const child = spawnLineProcess(
    command,
    ["app-server", ...overrideArgs, "--listen", "stdio://"],
    env === undefined ? {} : { env: { ...process.env, ...env } },
  );
  const pending = new Map<number, Pending>();
  // Inbound frames and marks share one queue until `handle` registers the
  // handlers, so their relative order is the wire's whatever kind they are.
  const held: ((handlers: AppServerHandlers) => void)[] = [];
  let handlers: AppServerHandlers | null = null;
  const deliver = (delivery: (handlers: AppServerHandlers) => void): void => {
    if (handlers === null) {
      held.push(delivery);
    } else {
      delivery(handlers);
    }
  };
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
      const { method } = message;
      if (hasId) {
        const id = String(message.id);
        deliver((target) => {
          target.onServerRequest(id, method, params);
        });
      } else {
        deliver((target) => {
          target.onNotification(method, params);
        });
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
    handle(registered) {
      if (handlers !== null) {
        throw new Error("app-server handlers are already registered");
      }
      handlers = registered;
      for (const delivery of held.splice(0)) {
        delivery(registered);
      }
    },
    mark(callback) {
      deliver(() => {
        callback();
      });
    },
    onExit(handler) {
      child.onExit(handler);
    },
    kill() {
      child.kill();
    },
  };
}
