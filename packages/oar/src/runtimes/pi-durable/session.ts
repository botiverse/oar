import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { watchEvents, type Conversation, type Harness, type SubmissionRecord, type WatchEnd } from "@earendil-works/pi-durable";
import type { ControlResult, InputOptions, RequestRecord, ResponseBody, RuntimeEventBody, Session, SessionOptions } from "../../contracts/session.js";
import { createSessionKernel } from "../../shared/session-kernel.js";
import { sealSession } from "../../shared/seal-session.js";
import { statusOf } from "../../observe/agent-status.js";
import { openConversation } from "./options.js";
import { foldDurableBatch, initialDurableProjection, submissionOutcome } from "./projection.js";

function settledOutcome(record: SubmissionRecord): readonly RuntimeEventBody[] {
  const outcome = submissionOutcome([record]);
  return outcome === undefined ? [] : [{ kind: "turn_ended", outcome }];
}

function errorSummary(error: unknown): { readonly name: string; readonly message: string; readonly code?: string | number } {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error),
    ...(typeof code === "string" || (typeof code === "number" && Number.isFinite(code)) ? { code } : {}) };
}

function watchEndSummary(end: WatchEnd): unknown {
  return end.reason === "listener_error" ? { reason: end.reason, error: errorSummary(end.error) } : end;
}

async function withdraw(harness: Harness, conversation: Conversation, inputId: string): Promise<ResponseBody> {
  const record = await harness.commit(async (tx) => { const value = await tx.submissionByRequest(conversation.id, inputId); return value; }, BACKGROUND_CONTEXT);
  const submission = record === undefined ? undefined : await harness.submission(record.id, BACKGROUND_CONTEXT);
  const native = await submission?.abort(BACKGROUND_CONTEXT);
  return native === "aborted" ? { kind: "accepted", native } : { kind: "rejected", code: "not_queued", reason: native ?? "No submission with this inputId", native };
}

export async function piDurableSession(harness: Harness, models: Models, options: SessionOptions): Promise<Session> {
  const conversation = await openConversation(harness, models, options);
  const stream = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT);
  const kernel = createSessionKernel(String(conversation.id));
  let state = initialDurableProjection(stream.snapshot);
  const initial = foldDurableBatch(state, [stream.snapshot]);
  state = initial.state;
  kernel.frame({ ...initial.frame, type: "snapshot", native: stream.snapshot });
  stream.start(async (events) => {
    const priorRun = state.run;
    const next = foldDurableBatch(state, events);
    state = next.state;
    kernel.frame(next.frame);
    if (events.some((event) => event.type === "snapshot" && event.run === undefined) && priorRun.length > 0) {
      try {
        const native = await Promise.all(priorRun.map(async (id) => {
          const handle = await harness.submission(id, BACKGROUND_CONTEXT);
          return handle?.status(BACKGROUND_CONTEXT);
        }));
        const outcome = submissionOutcome(native);
        kernel.frame({ type: "pi-durable/submissions", native, events: outcome === undefined ? [] : [{ kind: "turn_ended", outcome }] });
      } catch (error) { kernel.frame({ type: "pi-durable/submissions_error", native: errorSummary(error), events: [] }); }
    }
  });
  void (async (): Promise<void> => {
    const native = await stream.closed;
    kernel.frame({ type: "pi-durable/watch_closed", native: watchEndSummary(native), events: [] });
    if (native.reason !== "stopped" || kernel.unreachable()?.code !== "disposed") { kernel.respond("", { kind: "exited", code: null }); }
  })();
  // The host owns scheduling, but opening an OAR Session asks to control work,
  // unlike a read-only native watch. Recovery resumes unfinished tasks.
  try { harness.resume(); } catch (error) { await stream.stop(); throw error; }
  let disposing: Promise<void> | undefined = undefined;

  const submit = async (kind: "prompt" | "steer" | "queue", input: string, inputOptions: InputOptions, wasRunning: boolean): Promise<ResponseBody> => {
    if ((inputOptions.images?.length ?? 0) > 0) { return { kind: "rejected", code: "unsupported", reason: "pi-durable browser sessions do not read local image files" }; }
    const prior = inputOptions.inputId === undefined ? undefined : await harness.commit(async (tx) => { const value = await tx.submissionByRequest(conversation.id, inputOptions.inputId ?? ""); return value; }, BACKGROUND_CONTEXT);
    if (prior !== undefined) {
      kernel.frame({ type: "pi-durable/submission", native: prior, events: !wasRunning && state.run.length === 0 && kind === "prompt" ? settledOutcome(prior) : [] });
      return { kind: "accepted", native: prior };
    }
    if (kind === "prompt" && wasRunning) { return { kind: "rejected", code: "busy", reason: "busy" }; }
    if (kind === "steer" && state.run.length === 0) { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
    try {
      const submission = await conversation.submit({ type: "input", content: input, ...(inputOptions.inputId === undefined ? {} : { requestId: inputOptions.inputId }), whenBusy: kind === "prompt" ? "reject" : (kind === "steer" ? "steer" : "followUp") }, BACKGROUND_CONTEXT);
      const native = await submission.status(BACKGROUND_CONTEXT);
      kernel.frame({ type: "pi-durable/submission", native, events: [] });
      return { kind: "accepted", native };
    } catch (error) {
      const native = errorSummary(error);
      return { kind: "rejected", code: "runtime_refused", reason: native.message, native };
    }
  };
  const inputControl = async (kind: "prompt" | "steer" | "queue", input: string, inputOptions: InputOptions = {}): Promise<ControlResult> => {
    const wasRunning = statusOf(kernel.records(), kernel.sessionId).value.kind === "running";
    const result = await kernel.control({ kind, input, ...inputOptions }, async () => {
      const response = await submit(kind, input, inputOptions, wasRunning);
      return response;
    });
    return result;
  };
  return sealSession({
    id: kernel.sessionId,
    capabilities: { queue: { durable: true }, attribution: "opaque", images: false },
    prompt: async (input, inputOptions) => { const result = await inputControl("prompt", input, inputOptions); return result; },
    steer: async (input, inputOptions) => { const result = await inputControl("steer", input, inputOptions); return result; },
    queue: async (input, inputOptions) => { const result = await inputControl("queue", input, inputOptions); return result; },
    withdraw: async (inputId) => {
      const result = await kernel.control({ kind: "withdraw", inputId }, async () => { const response = await withdraw(harness, conversation, inputId); return response; });
      return result;
    },
    abort: async () => {
      const result = await kernel.control({ kind: "abort" }, async () => {
        if (state.run.length === 0) { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
        await conversation.abort(BACKGROUND_CONTEXT);
        return { kind: "accepted" };
      });
      return result;
    },
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    dispose: async () => {
      disposing ??= stopWatching(kernel.request("toRuntime", { kind: "dispose" }));
      await disposing;
    },
  });

  async function stopWatching(request: RequestRecord): Promise<void> {
    const native = await stream.stop();
    kernel.respond(request.id, { kind: "accepted", native: watchEndSummary(native) });
  }
}
