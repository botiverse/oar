import type { SessionOpenContext } from "../../contracts/placement.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Conversation, type ConversationView, type Harness, type SubmissionId, type SubmissionRecord, type WatchCall, type WatchEnd } from "@earendil-works/pi-durable";
import type { ControlResult, InputOptions, ResponseBody, RuntimeEventBody, Session, SessionOptions, TurnOutcome } from "../../contracts/session.js";
import { createSessionKernel } from "../../shared/session-kernel.js";
import { sealSession } from "../../shared/seal-session.js";
import { statusOf } from "../../observe/agent-status.js";
import { openConversation, type DurableModels } from "./options.js";
import { appendedEntries, foldDurableView, initialDurableProjection, liveOf, runEnded, submissionOutcome } from "./projection.js";

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
  return "error" in end ? { kind: end.kind, error: errorSummary(end.error) } : end;
}

async function withdraw(harness: Harness, conversation: Conversation, inputId: string): Promise<ResponseBody> {
  const record = await harness.commit(async (tx) => { const value = await tx.submissionByRequest(conversation.id, inputId); return value; }, BACKGROUND_CONTEXT);
  const submission = record === undefined ? undefined : await harness.submission(record.id, BACKGROUND_CONTEXT);
  const native = await submission?.abort(BACKGROUND_CONTEXT);
  return native === "aborted" ? { kind: "accepted", native } : { kind: "rejected", code: "not_queued", reason: native ?? "No submission with this inputId", native };
}

export async function piDurableSession(harness: Harness, models: DurableModels, options: SessionOptions, context?: SessionOpenContext): Promise<Session> {
  const conversation = await openConversation(harness, models, options);
  const kernel = createSessionKernel(String(conversation.id), undefined, options.retainedBytes);
  kernel.opened(context ?? { requested: "auto", placement: "in_process" });
  const pending: ({ readonly call: WatchCall<ConversationView> } | { readonly end: WatchEnd })[] = [];
  let draining: Promise<void> | undefined = undefined;
  let ready = false;
  const schedule = (): void => {
    if (!ready || draining !== undefined) { return; }
    draining = drainScheduled();
  };
  async function drainScheduled(): Promise<void> {
    await Promise.resolve();
    try { await drain(); }
    catch (error) {
      observation.detach();
      pending.length = 0;
      kernel.frame({ type: "pi-durable/projection_error", native: errorSummary(error), events: [] });
      kernel.respond("", { kind: "exited", code: null });
    } finally { draining = undefined; if (pending.length > 0) { schedule(); } }
  }
  // A synchronous observer runs on the native transaction line. Only enqueue
  // its immutable notification here: projection and native reads run later.
  const observation = await harness.observeConversation(conversation.id, {
    advance(call) { pending.push({ call }); schedule(); },
    end(end) { pending.push({ end }); schedule(); },
  }, BACKGROUND_CONTEXT);
  const initialize = (): ReturnType<typeof initialDurableProjection> => {
    try {
      const value = observation.value;
      const initial = foldDurableView(initialDurableProjection(value), { kind: "value", value, ops: [], retired: false }, [], true);
      kernel.frame(initial.frame);
      // The host owns scheduling; opening a controller resumes saved native work.
      harness.resume();
      return initial.state;
    } catch (error) { observation.detach(); pending.length = 0; throw error; }
  };
  let state = initialize();
  ready = true;
  schedule();

  async function receipts(ids: readonly SubmissionId[]): Promise<readonly (SubmissionRecord | undefined)[]> {
    const records = await Promise.all(ids.map(async id => {
      const handle = await harness.submission(id, BACKGROUND_CONTEXT);
      return handle?.status(BACKGROUND_CONTEXT);
    }));
    return records;
  }

  async function drain(): Promise<void> {
    while (pending.length > 0) {
      const item = pending.shift();
      if (item === undefined) { break; }
      if ("end" in item) {
        kernel.frame({ type: "pi-durable/watch_closed", native: watchEndSummary(item.end), events: [] });
        kernel.respond("", { kind: "exited", code: null });
        continue;
      }
      if (item.call.kind === "failed") {
        kernel.frame({ type: "pi-durable/watch_error", native: errorSummary(item.call.error), events: [] });
        continue;
      }
      const prior = state;
      const ended = runEnded(prior, item.call);
      let inputs: readonly SubmissionRecord[] = [];
      const hasUserEntry = appendedEntries(prior.view, item.call).some(entry => (entry.model ?? []).some(message => message.role === "user"));
      if (hasUserEntry) {
        try {
          const records = await receipts(liveOf(item.call.value).run?.inputs ?? []);
          inputs = records.filter(record => record !== undefined);
        } catch (error) { kernel.frame({ type: "pi-durable/submissions_error", native: errorSummary(error), events: [] }); }
      }
      let outcome: TurnOutcome | undefined = undefined;
      if (ended) {
        if (liveOf(prior.view).run?.afterRun !== undefined) {
          // The native run has already answered; it stayed busy only to await
          // its afterRun tasks, including for an observer attached mid-wait.
          outcome = { kind: "completed" };
        } else {
          try {
            const native = await receipts(prior.runInputs);
            outcome = submissionOutcome(native);
            kernel.frame({ type: "pi-durable/submissions", native: native.map(record => record ?? null), events: [] });
          } catch (error) { kernel.frame({ type: "pi-durable/submissions_error", native: errorSummary(error), events: [] }); }
        }
      }
      const next = foldDurableView(prior, item.call, inputs, false, outcome);
      state = next.state;
      kernel.frame(next.frame);
    }
  }

  const submit = async (kind: "prompt" | "steer" | "queue", input: string, inputOptions: InputOptions, wasRunning: boolean): Promise<ResponseBody> => {
    if ((inputOptions.images?.length ?? 0) > 0) { return { kind: "rejected", code: "unsupported", reason: "pi-durable browser sessions do not read local image files" }; }
    const prior = inputOptions.inputId === undefined ? undefined : await harness.commit(async (tx) => { const value = await tx.submissionByRequest(conversation.id, inputOptions.inputId ?? ""); return value; }, BACKGROUND_CONTEXT);
    if (prior !== undefined) {
      kernel.frame({ type: "pi-durable/submission", native: prior, events: !wasRunning && liveOf(state.view).run === undefined && kind === "prompt" ? settledOutcome(prior) : [] });
      return { kind: "accepted", native: prior };
    }
    if (kind === "prompt" && wasRunning) { return { kind: "rejected", code: "busy", reason: "busy" }; }
    if (kind === "steer" && liveOf(state.view).run === undefined) { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
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
        if (liveOf(state.view).run === undefined) { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
        await conversation.abort(BACKGROUND_CONTEXT);
        await flush();
        return { kind: "accepted" };
      });
      return result;
    },
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    dispose: async () => {
      await kernel.dispose(async request => {
        observation.detach();
        await flush();
        kernel.respond(request.id, { kind: "accepted" });
      }, () => { observation.detach(); });
    },
  });

  async function flush(): Promise<void> {
    let current = draining;
    while (current !== undefined) { await current; current = draining; }
  }
}
