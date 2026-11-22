import type { Frame, ResponseBody } from "../../contracts/session.js";
import { manualCompaction, type CompactionOperation, type CompactionSettlement } from "../../shared/manual-compaction.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import { KapApiError, kapRequest } from "./kap-protocol.js";

/** Manual compaction over KAP REST (`POST /sessions/{id}:compact`); settled by WS compaction events. */
function operation(
  kernel: SessionKernel,
  endpoint: { readonly origin: string; readonly token: string },
  sessionId: string,
): CompactionOperation {
  let active = false;
  return {
    async start(_request, reply: (body: ResponseBody) => void) {
      active = true;
      try {
        const data = await kapRequest(
          endpoint.origin,
          endpoint.token,
          `/sessions/${encodeURIComponent(sessionId)}:compact`,
          { method: "POST", body: {}, timeoutMs: 15_000 },
        );
        if (kernel.unreachable() !== null) { return; }
        reply({ kind: "accepted", native: data });
      } catch (error) {
        if (kernel.unreachable() !== null) { return; }
        if (error instanceof KapApiError) {
          reply({ kind: "rejected", code: "runtime_refused", reason: error.msg, native: error.envelope });
          return;
        }
        reply({ kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) });
      }
    },
    observe(frame: Frame): CompactionSettlement | null {
      if (!active) { return null; }
      for (const event of frame.body.events) {
        if (event.kind !== "compaction_ended") { continue; }
        if (event.trigger !== undefined && event.trigger !== "manual") { continue; }
        if (event.outcome === "completed") { return { kind: "completed", frame }; }
        if (event.outcome === "aborted") { return { kind: "aborted", frame }; }
        return { kind: "failed", code: "native_failed", reason: event.reason ?? "Kimi compaction failed", frame };
      }
      return null;
    },
  };
}

export function kimiKapCompaction(
  kernel: SessionKernel,
  endpoint: { readonly origin: string; readonly token: string },
  sessionId: string,
  busy: () => boolean,
): ReturnType<typeof manualCompaction> {
  return manualCompaction(kernel, {
    busy,
    busyReason: "Kimi manual compaction requires an idle session with no active turn or queued input",
    create: () => operation(kernel, endpoint, sessionId),
  });
}
