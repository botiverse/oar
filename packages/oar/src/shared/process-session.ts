import type { ControlResult, RequestRecord, ResponseRecord } from "../contracts/session.js";
import type { SessionCleanup, SessionRelease } from "../contracts/placement.js";
import type { ProcessLease, PooledProcess } from "./process-pool.js";
import type { SessionKernel } from "./session-kernel.js";

export interface ProcessSessionLifecycle {
  /** Only after the runtime's interrupt failed to settle within its fallback interval. */
  abortFallback(request: RequestRecord): Promise<ControlResult>;
  dispose(this: void): Promise<void>;
}

function cleanupQueue(kernel: SessionKernel, cleanup: () => Promise<void>, timeoutMs: number): (request: RequestRecord) => Promise<void> {
  let chain = Promise.resolve();
  const run = async (request: RequestRecord): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const deadline = new Promise<SessionCleanup>((resolve) => { timer = setTimeout(() => { resolve({ kind: "failed", reason: "session cleanup timed out; work may still be running" }); }, timeoutMs); });
    const attempt = (async (): Promise<SessionCleanup> => {
      try { await cleanup(); return { kind: "completed" }; }
      catch (error) { return { kind: "failed", reason: error instanceof Error ? error.message : String(error) }; }
    })();
    try { kernel.respond(request.id, { kind: "cleanup", result: await Promise.race([attempt, deadline]) }); }
    finally { clearTimeout(timer); }
  };
  return async (request) => {
    const previous = chain;
    chain = (async (): Promise<void> => {
      try { await previous; } catch { /* A prior reporting failure cannot poison later cleanup attempts. */ }
      await run(request);
    })();
    await chain;
  };
}

/** Recording and process ownership; native per-session cleanup stays in the adapter. */
export function processSessionLifecycle(kernel: SessionKernel, lease: ProcessLease<PooledProcess>, cleanup: () => Promise<void>, cleanupTimeoutMs = 1000): ProcessSessionLifecycle {
  let exitObserved = false;
  let released: ResponseRecord | undefined = undefined;
  let disposeRequest: RequestRecord | undefined = undefined;
  let disposal: Promise<void> | undefined = undefined;
  const hasExited = (): boolean => exitObserved;
  const recordExit = (code: number | null): void => {
    if (exitObserved) { return; }
    exitObserved = true;
    kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code });
  };
  const unsubscribe = lease.onExit(recordExit);
  const clean = cleanupQueue(kernel, cleanup, cleanupTimeoutMs);
  const release = (request: RequestRecord, reason: SessionRelease["reason"]): ResponseRecord => {
    released ??= kernel.respond(request.id, { kind: "released", reason, nativeTurnMayContinue: true, workStartedAfterCleanupMayContinue: true });
    return released;
  };
  const dispose = async (): Promise<void> => {
    const request = kernel.request("toRuntime", { kind: "dispose" });
    disposeRequest = request;
    try {
      if (hasExited()) { kernel.respond(request.id, { kind: "accepted" }); return; }
      if (lease.placement === "shared") { await clean(request); }
      const result = await lease.dispose();
      if (result === "released" && !hasExited()) {
        unsubscribe();
        if (released === undefined) { release(request, "dispose"); }
        else { kernel.respond(request.id, { kind: "accepted" }); }
      } else { recordExit(await lease.process.exited); }
    } catch (error) {
      if (hasExited()) { return; }
      kernel.respond(request.id, { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { disposeRequest = undefined; }
  };
  return {
    async abortFallback(request) {
      const answered = kernel.records().find((record): record is ResponseRecord => record.kind === "response" && record.requestId === request.id && (record.body.kind === "accepted" || record.body.kind === "rejected"));
      if (answered?.body.kind === "rejected") { return { request, response: answered }; }
      const blocked = kernel.unreachable();
      if (blocked !== null) { return { request, response: answered ?? kernel.respond(request.id, blocked) }; }
      // Reuse native acceptance; only a still-pending abort needs a response.
      const response = answered ?? kernel.respond(request.id, { kind: "accepted" });
      if (lease.placement === "shared") {
        release(request, "abort_fallback");
        await clean(request);
      } else {
        await lease.dispose();
        recordExit(await lease.process.exited);
      }
      return { request, response };
    },
    async dispose() {
      disposal ??= (async (): Promise<void> => {
        try { await dispose(); } catch (error) { disposal = undefined; throw error; }
      })();
      await disposal;
    },
  };
}
