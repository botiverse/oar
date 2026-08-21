import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";

/**
 * Minimal persistent JSON-RPC client over codex app-server's stdio JSONL
 * transport. Local to the codex runtime until a second consumer earns a
 * shared promotion.
 */
export interface AppServerClient {
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
  const child: ChildProcessByStdio<Writable, Readable, null> = spawn(
    command,
    ["app-server", "--listen", "stdio://"],
    { env: process.env, stdio: ["pipe", "pipe", "ignore"] },
  );
  const pending = new Map<number, Pending>();
  const notificationHandlers: ((method: string, params: JsonRecord) => void)[] = [];
  const exitHandlers: (() => void)[] = [];
  let nextId = 1;
  let buffer = "";

  child.stdout.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const message = raw.trim().length > 0 ? asRecord(parseJson(raw)) : null;
      if (message === null) {
        continue;
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
    }
  });
  child.on("exit", () => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error("app-server exited"));
    }
    pending.clear();
    for (const handler of exitHandlers) {
      handler();
    }
  });

  return {
    async request(method, params) {
      const id = nextId;
      nextId += 1;
      // oxlint-disable-next-line promise/avoid-new -- settlement is driven by the response pump
      const result = await new Promise<JsonRecord>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      return result;
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    },
    onNotification(handler) {
      notificationHandlers.push(handler);
    },
    onExit(handler) {
      exitHandlers.push(handler);
    },
    kill() {
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}
