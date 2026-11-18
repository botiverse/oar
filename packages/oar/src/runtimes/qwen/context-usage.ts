import { randomUUID } from "node:crypto";
import type { ContextUsage, ResponseBody, RuntimeEventBody } from "../../contracts/session.js";
import type { LineProcess } from "../../shared/executable/index.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import type { SessionKernel } from "../../shared/session-kernel.js";

/** Local readback measured at 2-15 ms; a missing answer must not hold turn completion indefinitely. */
export const QWEN_CONTEXT_TIMEOUT_MS = 1000;

const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Native last-prompt count, never result.usage's cumulative input or the estimated breakdown. */
export function qwenContextUsage(message: JsonRecord): ContextUsage | null {
  const response = asRecord(message.response);
  const data = response?.subtype === "success" ? asRecord(response.response) : null;
  if (data?.subtype !== "get_context_usage") { return null; }
  const window = count(data.contextWindowSize);
  const contextWindow = window !== null && window > 0 ? window : null;
  const tokens = data.isEstimated === false ? count(data.totalTokens) : null;
  if (tokens === null && contextWindow === null) { return null; }
  return { tokens, contextWindow, percent: tokens === null || contextWindow === null ? null : tokens / contextWindow * 100 };
}

/** Session-visible control, separate from private account/configuration queries. */
export function qwenContextReadback(child: Pick<LineProcess, "write">): {
  query(kernel: SessionKernel): Promise<void>;
  consume(message: JsonRecord): boolean;
  end(code?: "runtime_exited" | "disposed"): void;
} {
  let pending: { id: string; kernel: SessionKernel; finish(body: ResponseBody): void } | null = null;
  return {
    async query(kernel): Promise<void> {
      const id = `qwen-context-${randomUUID()}`;
      const native = { type: "control_request", request_id: id, request: { subtype: "get_context_usage", show_details: false } };
      const { promise, resolve } = Promise.withResolvers<void>();
      let settled = false;
      const finish = (body: ResponseBody): void => {
        if (settled) { return; }
        settled = true; pending = null; clearTimeout(timer); kernel.respond(id, body); resolve();
      };
      const isPending = (): boolean => !settled;
      const timer = setTimeout(() => { finish({ kind: "rejected", code: "error", reason: "Qwen context readback timed out" }); }, QWEN_CONTEXT_TIMEOUT_MS);
      pending = { id, kernel, finish };
      kernel.request("toRuntime", { kind: "native", type: "get_context_usage", native }, { id });
      const blocked = kernel.unreachable();
      if (blocked !== null) { finish(blocked); }
      else if (isPending()) {
        try { child.write(`${JSON.stringify(native)}\n`); }
        catch (error) { finish({ kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) }); }
      }
      await promise;
    },
    consume(message): boolean {
      const response = asRecord(message.response);
      const active = pending;
      if (message.type !== "control_response" || active === null || response?.request_id !== active.id) { return false; }
      const context = qwenContextUsage(message);
      const events: readonly RuntimeEventBody[] = context === null ? [] : [{ kind: "usage", usage: { context } }];
      active.kernel.frame({ type: "control_response", native: message, responseTo: active.id, events });
      active.finish(response.subtype === "success" ? { kind: "accepted" } : {
        kind: "rejected", code: "runtime_refused", reason: typeof response.error === "string" ? response.error : "Qwen refused context readback",
      });
      return true;
    },
    end(code = "runtime_exited"): void {
      pending?.finish(pending.kernel.unreachable() ?? { kind: "rejected", code, reason: "Qwen context readback stopped" });
    },
  };
}
