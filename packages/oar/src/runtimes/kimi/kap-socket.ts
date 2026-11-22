import { randomUUID } from "node:crypto";
import { asNumber, asRecord, parseJson, type JsonRecord } from "../../shared/json.js";
import { KapApiError } from "./kap-protocol.js";

export interface KapSocket {
  command(payload: JsonRecord, timeoutMs?: number): Promise<JsonRecord>;
  close(): Promise<void>;
  closed(): boolean;
}

interface PendingCommand {
  readonly resolve: (frame: JsonRecord) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function decodeWsMessage(data: unknown): string | null {
  if (typeof data === "string") { return data; }
  if (data instanceof ArrayBuffer) { return Buffer.from(data).toString("utf8"); }
  if (ArrayBuffer.isView(data)) { return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"); }
  return null;
}

async function waitForSocketOpen(
  ws: WebSocket,
  timeoutMs: number,
  onUnexpectedClose: () => void,
  onClosedSettle: () => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let opened = false;
    const timer = setTimeout(() => {
      if (opened) { return; }
      opened = true;
      ws.close();
      reject(new Error(`Kimi KAP WebSocket did not connect within ${String(timeoutMs)} ms`));
    }, timeoutMs);
    timer.unref();
    ws.addEventListener("open", () => {
      if (opened) { return; }
      opened = true;
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      if (opened) { return; }
      opened = true;
      clearTimeout(timer);
      reject(new Error("Kimi KAP WebSocket connection failed"));
    }, { once: true });
    ws.addEventListener("close", () => {
      onClosedSettle();
      if (!opened) {
        opened = true;
        clearTimeout(timer);
        reject(new Error("Kimi KAP WebSocket closed before open"));
        return;
      }
      onUnexpectedClose();
    }, { once: true });
  });
}

export async function connectKapSocket(
  wsUrl: string,
  token: string,
  handlers: {
    readonly onFrame: (frame: JsonRecord) => void;
    readonly onClose: () => void;
  },
  timeoutMs = 15_000,
): Promise<KapSocket> {
  const ws = new WebSocket(wsUrl, [`kimi-code.bearer.${token}`]);
  const pending = new Map<string, PendingCommand>();
  let isClosed = false;
  const closedPromise = Promise.withResolvers<void>();
  const failPending = (reason: string): void => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  };

  await waitForSocketOpen(
    ws,
    timeoutMs,
    handlers.onClose,
    () => {
      isClosed = true;
      failPending("Kimi KAP WebSocket closed");
      closedPromise.resolve();
    },
  );

  ws.addEventListener("message", (event) => {
    const raw = decodeWsMessage(event.data);
    if (raw === null) { return; }
    const frame = asRecord(parseJson(raw));
    if (frame === null) { return; }
    if (frame.type === "ping") {
      if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: "pong" })); }
      return;
    }
    if (frame.type === "response" && typeof frame.request_id === "string") {
      const waiter = pending.get(frame.request_id);
      if (waiter !== undefined) {
        pending.delete(frame.request_id);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
        return;
      }
    }
    handlers.onFrame(frame);
  });

  return {
    async command(payload, commandTimeoutMs = 15_000) {
      if (isClosed || ws.readyState !== WebSocket.OPEN) {
        throw new Error("Kimi KAP WebSocket is not open");
      }
      const requestId = randomUUID();
      const response = await new Promise<JsonRecord>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Kimi KAP WebSocket command timed out after ${String(commandTimeoutMs)} ms`));
        }, commandTimeoutMs);
        timer.unref();
        pending.set(requestId, { resolve, reject, timer });
        try {
          ws.send(JSON.stringify({ ...payload, request_id: requestId }));
        } catch (error) {
          pending.delete(requestId);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      const code = asNumber(response.code);
      if (code !== null && code !== 0) {
        const msg = typeof response.msg === "string" && response.msg.length > 0 ? response.msg : `KAP WS error ${String(code)}`;
        throw new KapApiError(code, msg, 200, response);
      }
      return response;
    },
    async close() {
      if (!isClosed) {
        failPending("Kimi KAP WebSocket closed");
        try { ws.close(); } catch { /* Socket may already be closing or closed. */ }
      }
      const grace = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          resolve();
        }, 500);
        timer.unref();
      });
      await Promise.race([closedPromise.promise, grace]);
    },
    closed: () => isClosed || ws.readyState === WebSocket.CLOSED,
  };
}
