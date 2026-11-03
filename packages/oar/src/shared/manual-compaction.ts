import type { CompactionOptions, CompactionOutcome } from "../contracts/compaction.js";
import type { Frame, RejectionCode, RequestRecord, ResponseBody, ResponseRecord } from "../contracts/session.js";
import type { RecordAt, SessionKernel } from "./session-kernel.js";

export type CompactionSettlement =
  | { readonly kind: "rejected"; readonly code: RejectionCode; readonly reason: string }
  | { readonly kind: "completed" | "aborted"; readonly frame: Frame }
  | { readonly kind: "failed"; readonly code: "native_failed" | "not_compacted" | "command_changed"; readonly reason: string; readonly frame?: Frame }
  | { readonly kind: "unconfirmed"; readonly code: "observation_failed"; readonly reason: string };

export interface CompactionOperation {
  /** Reply at native admission; finish only when this operation actually settles. */
  start(request: RequestRecord, reply: (body: ResponseBody, at?: RecordAt) => void): void | Promise<void | CompactionSettlement>;
  /** Called only for this session's root frames after the request. */
  observe(frame: Frame): CompactionSettlement | null;
}

interface Active {
  readonly request: RequestRecord;
  readonly operation: CompactionOperation;
  readonly resolve: (result: CompactionOutcome) => void;
  response?: ResponseRecord;
  settlement?: CompactionSettlement;
}

/** One native operation may outlive its caller's wait. It retains the input gate until native settlement. */
export function manualCompaction(kernel: SessionKernel, options: {
  readonly busy: () => boolean;
  readonly busyReason: string;
  readonly settledBy?: "native_response";
  readonly create: () => CompactionOperation;
  readonly released?: () => void;
}): { busy(): boolean; admitted(): boolean; requestId(): string | undefined; compact(this: void, options?: CompactionOptions): Promise<CompactionOutcome> } {
  let active: Active | null = null;
  let reserved = false;
  const release = (current: Active): void => {
    if (active !== current) { return; }
    active = null;
    reserved = false;
    options.released?.();
  };
  const completed = (current: Active): void => {
    if (current.response === undefined || current.settlement === undefined) { return; }
    current.resolve({ ...current.settlement, request: current.request, response: current.response });
    release(current);
  };
  kernel.rawEvents((record) => {
    const current = active;
    if (current === null || record.seq <= current.request.seq || record.sessionId !== kernel.sessionId || record.agentPath.length > 0) { return; }
    // Release before later observers see the refusal fold back to idle.
    if (record.kind === "response" && record.requestId === current.request.id && record.body.kind === "rejected") {
      current.response = record;
      current.resolve({ kind: "rejected", code: record.body.code, reason: record.body.reason, request: current.request, response: record });
      release(current);
    } else if ((record.kind === "request" && record.body.kind === "dispose")
      || (record.kind === "response" && (record.body.kind === "exited" || record.body.kind === "released"))) {
      const code = record.kind === "request" ? "disposed" : (record.body.kind === "released" ? "session_released" : "runtime_exited");
      current.resolve({ kind: "unconfirmed", code, reason: "Native compaction completion was not observed before the session became unavailable", request: current.request, ...(current.response === undefined ? {} : { response: current.response }) });
      release(current);
    } else if (record.kind === "frame") {
      const result = current.operation.observe(record);
      if (result !== null && current.settlement === undefined) { current.settlement = result; completed(current); }
    }
  });
  return {
    busy: () => reserved,
    requestId: () => active?.request.id,
    admitted: () => active?.response?.body.kind === "accepted",
    compact: async (wait = {}) => {
      if (wait.timeoutMs !== undefined && (!Number.isFinite(wait.timeoutMs) || wait.timeoutMs < 0)) { throw new RangeError("compact timeoutMs must be finite and non-negative"); }
      const blocked = wait.signal?.aborted === true
        ? { kind: "rejected", code: "aborted", reason: "The caller's signal was already aborted; no native compaction was sent" } as const
        : kernel.unreachable() ?? (reserved || options.busy() ? { kind: "rejected", code: "busy", reason: options.busyReason } as const : null);
      // Reserve before publishing: a synchronous record observer can issue another control.
      if (blocked === null) { reserved = true; }
      const request = kernel.request("toRuntime", { kind: "compact", ...(options.settledBy === undefined ? {} : { settledBy: options.settledBy }) });
      const refusal = blocked ?? kernel.unreachable();
      if (refusal !== null) {
        if (blocked === null) { reserved = false; }
        return { kind: "rejected", code: refusal.code, reason: refusal.reason, request, response: kernel.respond(request.id, refusal) };
      }
      const { promise, resolve } = Promise.withResolvers<CompactionOutcome>();
      let operation: CompactionOperation | null = null;
      try { operation = options.create(); }
      catch (error) {
        reserved = false;
        const reason = error instanceof Error ? error.message : String(error);
        return { kind: "rejected", code: "error", reason, request, response: kernel.respond(request.id, { kind: "rejected", code: "error", reason }) };
      }
      const current: Active = { request, operation, resolve };
      active = current;
      let timer: NodeJS.Timeout | null = null;
      const stopWaiting = (code: "timeout" | "signal"): void => {
        resolve({ kind: "unconfirmed", code, reason: "Stopped waiting; native compaction may still be running and its later records remain observable", request, ...(current.response === undefined ? {} : { response: current.response }) });
      };
      const abort = (): void => { stopWaiting("signal"); };
      wait.signal?.addEventListener("abort", abort, { once: true });
      if (wait.signal?.aborted === true) { abort(); }
      if (wait.timeoutMs !== undefined) { timer = setTimeout(() => { stopWaiting("timeout"); }, wait.timeoutMs); }
      const reply = (body: ResponseBody, at?: RecordAt): void => {
        if (active !== current || current.response !== undefined) { return; }
        current.response = kernel.respond(request.id, body, at);
        const recorded = current.response.body;
        if (recorded.kind === "rejected") {
          resolve({ kind: "rejected", code: recorded.code, reason: recorded.reason, request, response: current.response });
          release(current);
        } else { completed(current); }
      };
      void (async (): Promise<void> => {
        try {
          const settlement = await current.operation.start(request, reply);
          if (active === current && settlement !== undefined && current.settlement === undefined) { current.settlement = settlement; completed(current); }
        }
        catch (error) {
          if (active !== current) { return; }
          const reason = error instanceof Error ? error.message : String(error);
          if (current.response === undefined) { reply({ kind: "rejected", code: "runtime_refused", reason }); }
          else { resolve({ kind: "unconfirmed", code: "observation_failed", reason, request, response: current.response }); }
        }
      })();
      try { return await promise; }
      finally { if (timer !== null) { clearTimeout(timer); } wait.signal?.removeEventListener("abort", abort); }
    },
  };
}
