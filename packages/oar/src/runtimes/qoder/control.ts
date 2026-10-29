import { randomUUID } from "node:crypto";
import type { LineProcess } from "../../shared/executable/index.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { qoderTerminationReason } from "./protocol.js";

// Qoder initializes built-in plugins on every open; measured native starts reach 25s.
export const qoderInitializeTimeoutMs = 60_000;

interface QoderControl {
  end(this: void): void;
  consume(this: void, message: JsonRecord): boolean;
  request(this: void, request: JsonRecord, requestTimeoutMs?: number): Promise<JsonRecord>;
}

/** Account data in initialize, including its access token, never enters public records. */
export function qoderControl(child: LineProcess, remember: (value: unknown) => void, timeoutMs = 30_000): QoderControl {
  const pending = new Map<string, (answer: JsonRecord | Error) => void>();
  const privateIds = new Set<string>();
  let ended = false;
  const end = (): void => {
    ended = true;
    for (const finish of pending.values()) { finish(new Error(qoderTerminationReason(child) ?? "Qoder exited before answering a control request")); }
    pending.clear();
  };
  return {
    end,
    consume(message: JsonRecord): boolean {
      const response = asRecord(message.response);
      const id = message.type === "control_response" && typeof response?.request_id === "string" ? response.request_id : null;
      if (id === null || !privateIds.has(id)) { return false; }
      remember(message);
      pending.get(id)?.(message);
      return true;
    },
    async request(request: JsonRecord, requestTimeoutMs = timeoutMs): Promise<JsonRecord> {
      const id = `oar-qoder-${randomUUID()}`;
      const { promise, resolve } = Promise.withResolvers<JsonRecord | Error>();
      privateIds.add(id); pending.set(id, resolve);
      const timer = setTimeout(() => { resolve(new Error(`Qoder did not answer ${String(request.subtype ?? request.type)} within ${String(requestTimeoutMs)} ms`)); }, requestTimeoutMs);
      try {
        if (ended) { throw new Error("Qoder process has exited"); }
        child.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`);
        const answer = await promise;
        if (answer instanceof Error) { throw answer; }
        const response = asRecord(answer.response);
        if (response?.subtype !== "success") {
          // An account/configuration error may itself contain the private object.
          throw new Error(`Qoder refused ${String(request.subtype ?? request.type)}`);
        }
        return answer;
      } finally { clearTimeout(timer); pending.delete(id); }
    },
  };
}

/** Register only credential values obtained from the native private response, never account identity. */
export function rememberQoderSecrets(value: unknown, add: (value: string) => void): void {
  if (Array.isArray(value)) { for (const entry of value) { rememberQoderSecrets(entry, add); } return; }
  const record = asRecord(value);
  if (record === null) { return; }
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string" && /token|secret|password|api.?key/iu.test(key)) { add(entry); }
    else if (typeof entry === "object") { rememberQoderSecrets(entry, add); }
  }
}
