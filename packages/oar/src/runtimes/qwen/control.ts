import { randomUUID } from "node:crypto";
import type { LineProcess } from "../../shared/executable/index.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

/** Native process startup is part of every query, including model listing. */
export const QWEN_CONTROL_TIMEOUT_MS = 30_000;

interface QwenControl {
  readonly consume: (message: JsonRecord) => boolean;
  readonly end: () => void;
  readonly request: (request: JsonRecord) => Promise<JsonRecord>;
}

/** Private setup/readbacks; native account/configuration responses stay outside session records. */
export function qwenControl(child: LineProcess, timeoutMs = QWEN_CONTROL_TIMEOUT_MS): QwenControl {
  const pending = new Map<string, (answer: JsonRecord | Error) => void>();
  const privateIds = new Set<string>();
  let exited = false;
  const exitError = (): Error => {
    const diagnostic = child.diagnostics();
    return new Error(`Qwen exited before answering a control request: ${diagnostic.stderr}`);
  };
  return {
    consume(message: JsonRecord): boolean {
      const response = asRecord(message.response);
      const id = message.type === "control_response" && typeof response?.request_id === "string" ? response.request_id : null;
      if (id === null || !privateIds.has(id)) { return false; }
      pending.get(id)?.(message);
      return true;
    },
    end(): void {
      exited = true;
      for (const resolve of pending.values()) { resolve(exitError()); }
      pending.clear();
    },
    async request(request: JsonRecord): Promise<JsonRecord> {
      const id = `oar-${randomUUID()}`;
      const { promise, resolve } = Promise.withResolvers<JsonRecord | Error>();
      const timer = setTimeout(() => { resolve(new Error(`Qwen did not answer ${String(request.subtype)} within ${String(timeoutMs)} ms`)); }, timeoutMs);
      pending.set(id, resolve); privateIds.add(id);
      try {
        if (exited) { resolve(exitError()); }
        else { child.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`); }
        const answer = await promise;
        if (answer instanceof Error) { throw answer; }
        const response = asRecord(answer.response);
        if (response?.subtype !== "success") { throw new Error(`Qwen refused ${String(request.subtype)}: ${JSON.stringify(response?.error ?? "no success response")}`); }
        return answer;
      } finally { clearTimeout(timer); pending.delete(id); }
    },
  };
}

/** The actual Qwen permission dialect, verified with a native can_use_tool request. */
export function qwenPermissionResponse(requestId: string, request: JsonRecord): JsonRecord {
  return { type: "control_response", response: { subtype: "success", request_id: requestId,
    response: { behavior: "allow", ...(request.input === undefined ? {} : { updatedInput: request.input }) } } };
}
