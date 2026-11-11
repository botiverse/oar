// BYOK change: Modified from OAR 95c6547 to type the caller-injected line process (Apache-2.0).
import type { ControlResult, ResponseBody, ResponseRecord } from "../../contracts/session.js";
import type { LineProcess } from "../../runtimes/codex/app-server-client.js"; // BYOK change: the injected line process type.
import { asRecord, type JsonRecord } from "../json.js";
import type { SessionKernel } from "../session-kernel.js";

/** Native per-task control, independent of the root turn and its abort fallback. */
export function streamJsonTaskControl(kernel: SessionKernel, child: Pick<LineProcess, "write">, requestBody: (taskId: string) => JsonRecord): { stop(this: void, taskId: string): Promise<ControlResult>; consume(message: JsonRecord): boolean; end(): void } {
  const pending = new Map<string, (body: ResponseBody) => void>();
  return {
    async stop(taskId: string): Promise<ControlResult> {
      const blocked = kernel.unreachable();
      const request = kernel.request("toRuntime", { kind: "stop_task", taskId });
      const refused = blocked ?? kernel.unreachable() ?? (taskId === "" ? { kind: "rejected" as const, code: "unsupported" as const, reason: "A native task id is required" } : null);
      if (refused !== null) { return { request, response: kernel.respond(request.id, refused) }; }
      const result = Promise.withResolvers<ResponseRecord>();
      const timer = setTimeout(() => {
        pending.get(request.id)?.({ kind: "rejected", code: "error", reason: "Native task-stop response timed out; task state is unconfirmed" });
      }, 30_000);
      pending.set(request.id, (body) => {
        pending.delete(request.id); clearTimeout(timer);
        result.resolve(kernel.respond(request.id, body));
      });
      try {
        child.write(`${JSON.stringify({ type: "control_request", request_id: request.id, request: requestBody(taskId) })}\n`);
      } catch (error) {
        pending.get(request.id)?.({ kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) });
      }
      return { request, response: await result.promise };
    },
    consume(message: JsonRecord): boolean {
      const response = asRecord(message.response);
      const id = response?.request_id;
      const settle = message.type === "control_response" && typeof id === "string" ? pending.get(id) : undefined;
      if (settle === undefined) { return false; }
      if (response?.subtype === "success") { settle({ kind: "accepted", native: message }); }
      else if (response?.subtype === "error") {
        settle({ kind: "rejected", code: "runtime_refused", reason: typeof response.error === "string" ? response.error : "Native task stop was refused", native: message });
      } else { return false; }
      return true;
    },
    end(): void {
      for (const settle of pending.values()) {
        settle(kernel.unreachable() ?? { kind: "rejected", code: "disposed", reason: "Session is closing" });
      }
    },
  };
}
