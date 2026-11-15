import type { RequestRecord, ResponseBody } from "../../contracts/session.js";
import type { SessionKernel } from "../../shared/session-kernel.js";

/** Only an actual SDK refusal returns a queued input; an unresolved send stays pending. */
export default async function settleQueuedSend(kernel: SessionKernel, dispatch: {
  readonly request: RequestRecord;
  readonly input: string;
  readonly inputId: string | undefined;
  readonly decision: ResponseBody | Promise<ResponseBody>;
}, settled: () => void): Promise<void> {
  const decided = await dispatch.decision;
  if (decided.kind === "rejected" && decided.code === "runtime_refused") {
    kernel.frame({ type: "cursor/send_rejected", native: { message: decided.reason, input: dispatch.input },
      events: [{ kind: "input_dropped", requestId: dispatch.request.id, ...(dispatch.inputId === undefined ? {} : { inputId: dispatch.inputId }), reason: "runtime_refused", message: decided.reason }] });
  }
  kernel.respond(dispatch.request.id, decided);
  settled();
}
