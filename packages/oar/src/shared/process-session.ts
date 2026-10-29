import type { ControlResult, RequestRecord, ResponseRecord } from "../contracts/session.js";
import type { SessionCleanup, SessionRelease } from "../contracts/placement.js";
import type { ProcessLease, PooledProcess } from "./process-pool.js";
import type { SessionKernel } from "./session-kernel.js";

export interface ProcessSessionLifecycle {
  /** Only after the runtime's interrupt failed to settle within its fallback interval. */
  abortFallback(request: RequestRecord): Promise<ControlResult>;
  dispose(this: void): Promise<void>;
}

/** Recording and process ownership; native per-session cleanup stays in the adapter. */
export function processSessionLifecycle(
  kernel: SessionKernel,
  lease: ProcessLease<PooledProcess>,
  cleanup: () => Promise<void>,
  cleanupTimeoutMs = 1000,
): ProcessSessionLifecycle {
  let exitObserved = false;
  let disposeRequest: RequestRecord | undefined = undefined;
  let disposal: Promise<void> | undefined = undefined;
  let cleanupChain = Promise.resolve();
  const hasExited = (): boolean => exitObserved;
  const exitRequestId = (): string => disposeRequest?.id ?? "";
  const observedExit = (async (): Promise<void> => {
    const code = await lease.process.exited;
    exitObserved = true;
    kernel.respond(exitRequestId(), { kind: "exited", code });
  })();
  const clean = async (request: RequestRecord): Promise<void> => {
    const run = async (): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const deadline = new Promise<SessionCleanup>((resolve) => { timer = setTimeout(() => { resolve({ kind: "failed", reason: "session cleanup timed out; work may still be running" }); }, cleanupTimeoutMs); });
      const attempt = (async (): Promise<SessionCleanup> => {
        try { await cleanup(); return { kind: "completed" }; }
        catch (error) { return { kind: "failed", reason: error instanceof Error ? error.message : String(error) }; }
      })();
      const result = await Promise.race([attempt, deadline]);
      clearTimeout(timer);
      kernel.respond(request.id, { kind: "cleanup", result });
    };
    const previous = cleanupChain;
    cleanupChain = (async (): Promise<void> => { await previous; await run(); })();
    await cleanupChain;
  };
  const release = (request: RequestRecord, reason: SessionRelease["reason"]): ResponseRecord => kernel.respond(request.id, {
    kind: "released", reason, nativeTurnMayContinue: true, workStartedAfterCleanupMayContinue: true,
  });
  return {
    async abortFallback(request) {
      const blocked = kernel.unreachable();
      if (blocked !== null) { return { request, response: kernel.respond(request.id, blocked) }; }
      // Acceptance must precede release/exit so a replay retains the stop evidence.
      const response = kernel.respond(request.id, { kind: "accepted" });
      if (lease.placement === "shared") {
        // Close control before awaiting native cleanup. A late native turn end
        // must not admit a new prompt while the fallback is releasing this session.
        release(request, "abort_fallback");
        await clean(request);
      } else {
        await lease.dispose();
        await observedExit;
      }
      return { request, response };
    },
    async dispose() {
      disposal ??= (async (): Promise<void> => {
        disposeRequest = kernel.request("toRuntime", { kind: "dispose" });
        if (hasExited()) { kernel.respond(disposeRequest.id, { kind: "accepted" }); return; }
        if (lease.placement === "shared") { await clean(disposeRequest); }
        const result = await lease.dispose();
        if (result === "released" && !hasExited()) { release(disposeRequest, "dispose"); }
        else { await observedExit; }
      })();
      await disposal;
    },
  };
}
