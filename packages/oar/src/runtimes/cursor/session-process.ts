import type { RequestRecord, SessionOptions } from "../../contracts/session.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import type { CursorSdkAccess, CursorSdkLease } from "./access.js";
import { openCursorAgent } from "./model.js";
import type { CursorAgent } from "./sdk.js";
import type { CursorChildExit } from "./subprocess/channel.js";

/**
 * The session's SDK and its agent. In subprocess mode the lease is the
 * session's own child, which also answers the model and run lookups the open
 * makes; an open that fails ends it.
 */
export async function openCursorSession(access: CursorSdkAccess, options: SessionOptions): Promise<{ readonly lease: CursorSdkLease; readonly agent: CursorAgent }> {
  refuseSessionOptions(access.refusedSessionOptions, options);
  const lease = await access.lease(options.env);
  try {
    const agent = await openCursorAgent(lease.sdk, options);
    return { lease, agent };
  } catch (error) {
    await lease.release();
    throw error;
  }
}

/**
 * How a cursor session ends. In process there is no process exit to
 * observe, so a dispose is answered `accepted`. In subprocess mode the
 * child's exit is recorded as `exited`, as process runtimes record theirs
 * (shared/process-session.ts): unasked (a crash), once the turn it cut short
 * has ended (`settle`), with the reason and a stderr tail; or as the answer
 * to the dispose that stopped it. An exit that comes after the dispose began
 * answers that dispose, a crash keeping its reason. When the exit was
 * recorded before the dispose began (against no request), the dispose is
 * answered `accepted`, as shared/process-session.ts answers it.
 */
export function cursorSessionEnd(kernel: SessionKernel, lease: CursorSdkLease, settle: () => Promise<void>): {
  /** As the dispose begins, before it cancels anything. */
  disposing(request: RequestRecord): void;
  /** After the agent was closed: end the child, if any, and answer the dispose. */
  disposed(): Promise<void>;
} {
  let recorded = false;
  let disposeRequest: RequestRecord | null = null;
  // The exit was recorded before the dispose began: the dispose finds nothing to stop.
  let goneBefore = false;
  // An exit nobody asked for, kept for a dispose that comes before it is recorded.
  let unasked: CursorChildExit | null = null;
  const record = (exit: CursorChildExit, reason?: string): void => {
    if (recorded) { return; }
    recorded = true;
    kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code: exit.code, ...(reason === undefined ? {} : { reason }) });
  };
  lease.child?.onExit((exit) => {
    if (lease.child?.stopping() === true) { return; }
    unasked = exit;
    void (async (): Promise<void> => {
      await settle();
      record(exit, exit.reason);
    })();
  });
  return {
    disposing(request) {
      // An exit already recorded answered no request: this dispose is then answered `accepted` below.
      goneBefore = recorded;
      disposeRequest = request;
    },
    async disposed() {
      if (disposeRequest === null) { return; }
      if (lease.child === null || goneBefore) {
        // In process, or the child was already gone: nothing is left to stop.
        kernel.respond(disposeRequest.id, { kind: "accepted" });
        return;
      }
      const exit = await lease.release();
      if (unasked !== null) { record(unasked, unasked.reason); }
      else if (exit !== null) { record(exit); }
    },
  };
}
