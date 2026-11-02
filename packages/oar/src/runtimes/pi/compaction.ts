import type { ResponseBody } from "../../contracts/session.js";
import { manualCompaction, type CompactionOperation } from "../../shared/manual-compaction.js";
import type { SessionKernel } from "../../shared/session-kernel.js";

/** SDK and bundled RPC share manual start/end facts. No automatic boundary can settle this call. */
export function piCompaction(kernel: SessionKernel, run: () => Promise<unknown>): CompactionOperation {
  let reply: ((body: ResponseBody) => void) | undefined = undefined;
  let started = false;
  let ended = false;
  return {
    async start(_request, respond) {
      reply = respond;
      try { await run(); }
      catch (error) {
        if (ended || kernel.unreachable() !== null) { return; }
        const reason = error instanceof Error ? error.message : String(error);
        if (!started) { respond({ kind: "rejected", code: "runtime_refused", reason }); }
        else {
          // An SDK rejection is native failure evidence, even if its end event was missing.
          kernel.frame({ type: "pi/compact_rejected", native: { message: reason }, events: [{ kind: "compaction_ended", outcome: "failed", trigger: "manual", reason }] });
        }
      }
    },
    observe(frame) {
      for (const event of frame.body.events) {
        if (event.kind === "compaction_started" && event.trigger === "manual") { started = true; reply?.({ kind: "accepted" }); }
        if (!started || event.kind !== "compaction_ended" || event.trigger !== "manual") { continue; }
        ended = true;
        return event.outcome === "failed"
          ? { kind: "failed", code: "native_failed", reason: event.reason ?? "Pi reported compaction failure", frame }
          : { kind: event.outcome, frame };
      }
      return null;
    },
  };
}

export function piManualCompaction(kernel: SessionKernel, busy: () => boolean, run: () => Promise<unknown>, released: () => void): ReturnType<typeof manualCompaction> {
  return manualCompaction(kernel, {
    busy, busyReason: "Pi manual compaction requires an idle session; it would otherwise abort the active turn",
    create: () => piCompaction(kernel, run), released,
  });
}
