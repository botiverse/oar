import type { ControlResult } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import type { AppServerClient } from "./app-server-client.js";
import { rpcControl } from "./rpc-control.js";
import type { SubagentThreads } from "./tasks.js";

/** Interrupt only a descendant's observed current turn, never the parent or a peer session. */
export function codexTaskControl(kernel: SessionKernel, client: AppServerClient, children: () => SubagentThreads): { observe(method: string, params: JsonRecord): void; stop(this: void, taskId: string): Promise<ControlResult> } {
  const turns = new Map<string, string>();
  function owns(taskId: string): boolean {
    const seen = new Set<string>();
    let child = taskId;
    while (child !== kernel.sessionId && !seen.has(child)) {
      seen.add(child);
      const parent = children().get(child)?.parent;
      if (parent === kernel.sessionId) { return true; }
      if (parent === undefined) { return false; }
      child = parent;
    }
    return false;
  }
  return {
    observe(method: string, params: JsonRecord): void {
      const thread = params.threadId;
      const turn = asRecord(params.turn)?.id;
      if (typeof thread !== "string" || thread === kernel.sessionId || typeof turn !== "string") { return; }
      if (method === "turn/started") { turns.set(thread, turn); }
      else if (method === "turn/completed" && turns.get(thread) === turn) { turns.delete(thread); }
    },
    async stop(taskId: string): Promise<ControlResult> {
      let turnId: string | undefined = undefined;
      const result = await rpcControl(kernel, client, {
        body: { kind: "stop_task", taskId }, method: "turn/interrupt",
        gate: () => {
          const blocked = kernel.unreachable();
          if (blocked !== null) { return blocked; }
          if (!owns(taskId)) { return { kind: "rejected", code: "unsupported", reason: "Task id is not an observed child of this session" }; }
          turnId = turns.get(taskId);
          return turnId === undefined ? { kind: "rejected", code: "no_active_turn", reason: "No active turn has been observed for this task" } : null;
        },
        params: () => ({ threadId: taskId, turnId }),
        onReply: native => ({ kind: "accepted", native }),
        onError: (reason, native) => ({ kind: "rejected", code: "runtime_refused", reason, ...(native === undefined ? {} : { native }) }),
      });
      return result;
    },
  };
}
