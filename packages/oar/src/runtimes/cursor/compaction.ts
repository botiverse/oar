import type { Frame, ResponseBody } from "../../contracts/session.js";
import { asRecord } from "../../shared/json.js";
import type { CompactionOperation } from "../../shared/manual-compaction.js";
import type { CursorRun } from "./sdk.js";

/** The SDK returns the exact summary run before its messages are consumed. */
export function cursorCompaction(start: (onRun: (run: CursorRun) => void) => Promise<ResponseBody>): CompactionOperation {
  const observation = Promise.withResolvers<void>();
  // Observation may fail while start still awaits an early abort's cancel.
  // oxlint-disable-next-line promise/prefer-await-to-then -- Attach immediately, before start can await cancellation.
  void observation.promise.catch(() => {});
  let sessionId: string | null = null;
  let runId: string | null = null;
  let summary: Frame | null = null;
  return {
    async start(request, reply) {
      sessionId = request.sessionId;
      const response = await start((run) => {
        runId = run.id;
        reply({ kind: "accepted", native: { runId } }, { spanId: runId });
      });
      if (response.kind === "rejected") { reply(response); return; }
      await observation.promise;
    },
    observe(frame) {
      if (runId === null || frame.spanId !== runId) { return null; }
      if (frame.body.type === "cursor/run_failed" || frame.body.type === "cursor/stream_failed" || frame.body.type === "cursor/stream_unclosed") {
        observation.reject(new Error("Cursor summary observation failed; native completion is not known"));
        return null;
      }
      if (frame.body.type === "cursor/stream/summary" && asRecord(frame.body.native)?.agent_id === sessionId && frame.body.events.some((event) => event.kind === "compaction_ended")) { summary = frame; }
      if (frame.body.type !== "cursor/run_result") { return null; }
      const native = asRecord(frame.body.native);
      if (native?.id !== runId) { return null; }
      observation.resolve();
      // A completed summary remains completed even if cancellation arrives during run bookkeeping.
      if (summary !== null) {
        return summary.body.events.some((event) => event.kind === "compaction_ended" && event.outcome === "completed")
          ? { kind: "completed", frame: summary }
          : { kind: "failed", code: "native_failed", reason: "Cursor reported a summary error", frame: summary };
      }
      if (native.status === "cancelled") { return { kind: "aborted", frame }; }
      if (native.status === "error") { return { kind: "failed", code: "native_failed", reason: "Cursor reported a failed summary run", frame }; }
      return { kind: "unconfirmed", code: "observation_failed", reason: "Cursor ended the summary run without an observed terminal summary status" };
    },
  };
}
