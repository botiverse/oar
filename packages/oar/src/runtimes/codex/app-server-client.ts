import { spawnLineProcess } from "../../shared/executable/index.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";

/**
 * Minimal persistent JSON-RPC client over codex app-server's stdio JSONL
 * transport. Local to the codex runtime until a second consumer earns a
 * shared promotion; process mechanics live in shared/executable.
 */
export interface AppServerClient {
  readonly spawned: Promise<void>;
  request(method: string, params: JsonRecord): Promise<JsonRecord>;
  notify(method: string, params: JsonRecord): void;
  onNotification(handler: (method: string, params: JsonRecord) => void): void;
  onExit(handler: () => void): void;
  kill(): void;
}

interface Pending {
  resolve(result: JsonRecord): void;
  reject(error: Error): void;
}

export function startAppServerClient(command: string): AppServerClient {
  const child = spawnLineProcess(command, ["app-server", "--listen", "stdio://"]);
  const pending = new Map<number, Pending>();
  const notificationHandlers: ((method: string, params: JsonRecord) => void)[] = [];
  let nextId = 1;

  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message === null) {
      return;
    }
    if (typeof message.id === "number" && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      const error = asRecord(message.error);
      if (error !== null) {
        waiter?.reject(new Error(typeof error.message === "string" ? error.message : "app-server error"));
      } else {
        waiter?.resolve(asRecord(message.result) ?? {});
      }
    } else if (typeof message.method === "string") {
      const params = asRecord(message.params) ?? {};
      for (const handler of notificationHandlers) {
        handler(message.method, params);
      }
    }
  });
  child.onExit(() => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error("app-server exited"));
    }
    pending.clear();
  });

  return {
    spawned: child.spawned,
    async request(method, params) {
      const id = nextId;
      nextId += 1;
      // oxlint-disable-next-line promise/avoid-new -- settlement is driven by the response pump
      const result = await new Promise<JsonRecord>((resolve, reject) => {
        pending.set(id, { resolve, reject });
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
    onExit(handler) {
      child.onExit(handler);
    },
    kill() {
      child.kill();
    },
  };
}
