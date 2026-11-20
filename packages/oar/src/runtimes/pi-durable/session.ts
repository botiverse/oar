import type { SessionOpenContext } from "../../contracts/placement.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ConversationBusy, ConversationIdle, type Conversation, type ConversationView, type Harness, type Submission, type SubmissionId, type SubmissionRecord, type WatchCall, type WatchEnd } from "@earendil-works/pi-durable";
import type { ControlResult, InputOptions, RequestRecord, ResponseBody, RuntimeEventBody, Session, SessionOptions, TurnOutcome } from "../../contracts/session.js";
import { createSessionKernel } from "../../shared/session-kernel.js";
import { sealSession } from "../../shared/seal-session.js";
import { openConversation, type DurableModels } from "./options.js";
import { appendedEntries, foldDurableView, inboxInputIds, initialDurableProjection, liveOf, runEnded, submissionOutcome } from "./projection.js";

const ABORT_TIMEOUT_MS = 10_000;
const UNSUPPORTED_IMAGES: ResponseBody = { kind: "rejected", code: "unsupported", reason: "pi-durable browser sessions do not read local image files" };

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

interface PendingQueue {
  readonly inputId: string | undefined;
  withdrawn: boolean;
  intercepted: boolean;
  readonly settled: Promise<boolean>;
  readonly resolve: (intercepted: boolean) => void;
}

function createPendingQueue(pendingQueues: Set<PendingQueue>, inputId: string | undefined): PendingQueue {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const entry: PendingQueue = { inputId, withdrawn: false, intercepted: false, settled: promise, resolve };
  pendingQueues.add(entry);
  return entry;
}

async function withdraw(harness: Harness, conversation: Conversation, pendingQueues: Set<PendingQueue>, withdrawn: Set<SubmissionId>, inputId: string): Promise<ResponseBody> {
  const matching = [...pendingQueues].filter(entry => entry.inputId === inputId);
  for (const entry of matching) { entry.withdrawn = true; }
  const settled = matching.length === 0 ? [] : await Promise.all(matching.map(async entry => { const value = await entry.settled; return value; }));
  const intercepted = settled.some(Boolean);
  const record = await harness.commit(async (tx) => { const value = await tx.submissionByRequest(conversation.id, inputId); return value; }, BACKGROUND_CONTEXT);
  const submission = record === undefined ? undefined : await harness.submission(record.id, BACKGROUND_CONTEXT);
  const native = await submission?.abort(BACKGROUND_CONTEXT);
  if (native === "aborted") {
    if (record !== undefined) { withdrawn.add(record.id); }
    return { kind: "accepted", native };
  }
  return intercepted ? { kind: "accepted" } : { kind: "rejected", code: "not_queued", reason: native ?? "No submission with this inputId", native };
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

  const withdrawnSubmissions = new Set<SubmissionId>();
  const droppedSubmissions = new Set<SubmissionId>();
  const trackedQueued = new Set<SubmissionId>();
  const submissionMeta = new Map<SubmissionId, { readonly requestId: string; readonly inputId?: string }>();
  const droppedEventsOf = (records: readonly (SubmissionRecord | undefined)[]): RuntimeEventBody[] => {
    const events: RuntimeEventBody[] = [];
    for (const record of records) {
      if (record === undefined) { continue; }
      if (record.status !== "queued") { trackedQueued.delete(record.id); }
      if (record.status !== "unanswered" || record.reason !== "aborted" || record.entry !== undefined
        || withdrawnSubmissions.has(record.id) || droppedSubmissions.has(record.id)) { continue; }
      droppedSubmissions.add(record.id);
      const meta = submissionMeta.get(record.id);
      const inputId = record.requestId ?? meta?.inputId;
      if (meta !== undefined) {
        events.push({ kind: "input_dropped", reason: "turn_interrupted", requestId: meta.requestId, ...(inputId === undefined ? {} : { inputId }) });
      } else if (inputId !== undefined) {
        events.push({ kind: "input_dropped", reason: "turn_interrupted", inputId });
      }
    }
    return events;
  };

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
      const currentInbox = new Set(inboxInputIds(item.call.value));
      const currentRunInputs = new Set(liveOf(item.call.value).run?.inputs);
      const placedIds = new Set(inputs.map(record => record.id));
      const candidateDropped = [...new Set([...prior.inboxIds, ...trackedQueued])].filter(id =>
        !currentInbox.has(id) && !currentRunInputs.has(id) && !placedIds.has(id) && !withdrawnSubmissions.has(id) && !droppedSubmissions.has(id));
      const dropped: RuntimeEventBody[] = [];
      if (candidateDropped.length > 0) {
        try {
          const settled = await receipts(candidateDropped);
          const events = droppedEventsOf(settled);
          if (events.length > 0) {
            dropped.push(...events);
            kernel.frame({ type: "pi-durable/submissions", native: settled.map(record => record ?? null), events: [] });
          }
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
            dropped.push(...droppedEventsOf(native));
            kernel.frame({ type: "pi-durable/submissions", native: native.map(record => record ?? null), events: [] });
          } catch (error) { kernel.frame({ type: "pi-durable/submissions_error", native: errorSummary(error), events: [] }); }
        }
      }
      const next = foldDurableView(prior, item.call, inputs, false, outcome, dropped);
      state = next.state;
      kernel.frame(next.frame);
    }
  }

  const pendingQueues = new Set<PendingQueue>();
  let admissions = Promise.resolve();
  const runningNow = async (): Promise<boolean> => {
    await flush();
    return liveOf(state.view).run !== undefined || liveOf(observation.value).run !== undefined;
  };
  const submit = async (request: RequestRecord, kind: "prompt" | "steer" | "queue", input: string, inputOptions: InputOptions, wasRunning: boolean, queued?: PendingQueue): Promise<ResponseBody> => {
    if (kind === "steer") {
      if (!(await runningNow())) { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
      if ((inputOptions.images?.length ?? 0) > 0) { return UNSUPPORTED_IMAGES; }
    }
    const prior = inputOptions.inputId === undefined ? undefined : await harness.commit(async (tx) => { const value = await tx.submissionByRequest(conversation.id, inputOptions.inputId ?? ""); return value; }, BACKGROUND_CONTEXT);
    if (prior !== undefined) {
      kernel.frame({ type: "pi-durable/submission", native: prior, events: !wasRunning && liveOf(state.view).run === undefined && kind === "prompt" ? settledOutcome(prior) : [] });
      return { kind: "accepted", native: prior };
    }
    if (queued?.withdrawn === true) { queued.intercepted = true; return { kind: "accepted" }; }
    if (kind === "prompt" && wasRunning) { return { kind: "rejected", code: "busy", reason: "busy" }; }
    if ((inputOptions.images?.length ?? 0) > 0) { return UNSUPPORTED_IMAGES; }
    const whenBusy = kind === "prompt" ? "reject" : (kind === "steer" ? "steer" : "followUp");
    let submission: Submission | null = null;
    try {
      submission = await conversation.submit({
        type: "input", content: input,
        ...(inputOptions.inputId === undefined ? {} : { requestId: inputOptions.inputId }),
        whenBusy, ...(kind === "steer" ? { whenIdle: "reject" as const } : {}),
      }, BACKGROUND_CONTEXT);
    } catch (error) {
      const native = errorSummary(error);
      if (error instanceof ConversationIdle) { return { kind: "rejected", code: "no_active_turn", reason: native.message, native }; }
      if (error instanceof ConversationBusy) { return { kind: "rejected", code: "busy", reason: "busy", native }; }
      return { kind: "rejected", code: "runtime_refused", reason: native.message, native };
    }
    submissionMeta.set(submission.id, { requestId: request.id, ...(inputOptions.inputId === undefined ? {} : { inputId: inputOptions.inputId }) });
    try {
      const native = await submission.status(BACKGROUND_CONTEXT);
      if (native.status === "queued") { trackedQueued.add(submission.id); }
      kernel.frame({ type: "pi-durable/submission", native, events: [] });
      return { kind: "accepted", native };
    } catch (error) {
      kernel.frame({ type: "pi-durable/submissions_error", native: errorSummary(error), events: [] });
      return { kind: "accepted" };
    }
  };
  const admit = async (run: () => Promise<ResponseBody>, queued?: PendingQueue): Promise<ResponseBody> => {
    const previous = admissions;
    const current = (async (): Promise<ResponseBody> => { await previous; const response = await run(); return response; })();
    admissions = (async (): Promise<void> => { try { await current; } catch { /* Independent submissions do not block later ones. */ } })();
    try { const response = await current; return response; }
    finally { if (queued !== undefined) { pendingQueues.delete(queued); queued.resolve(queued.intercepted); } }
  };
  const inputControl = async (kind: "prompt" | "steer" | "queue", input: string, inputOptions: InputOptions = {}): Promise<ControlResult> => {
    const wasRunning = session.status().value.kind === "running";
    const result = await kernel.control({ kind, input, ...inputOptions }, async (request) => {
      if (kind === "queue" && (inputOptions.images?.length ?? 0) > 0) { return UNSUPPORTED_IMAGES; }
      const queued = kind === "queue" ? createPendingQueue(pendingQueues, inputOptions.inputId) : undefined;
      const response = await admit(async () => { const value = await submit(request, kind, input, inputOptions, wasRunning, queued); return value; }, queued);
      return response;
    });
    return result;
  };
  const session = sealSession({
    id: kernel.sessionId,
    capabilities: { queue: { durable: true }, attribution: "opaque", images: false },
    prompt: async (input, inputOptions) => { const result = await inputControl("prompt", input, inputOptions); return result; },
    steer: async (input, inputOptions) => { const result = await inputControl("steer", input, inputOptions); return result; },
    queue: async (input, inputOptions) => { const result = await inputControl("queue", input, inputOptions); return result; },
    withdraw: async (inputId) => {
      const result = await kernel.control({ kind: "withdraw", inputId }, async () => { const response = await withdraw(harness, conversation, pendingQueues, withdrawnSubmissions, inputId); return response; });
      return result;
    },
    abort: async () => {
      const result = await kernel.control({ kind: "abort" }, async () => {
        await admissions;
        if (!(await runningNow())) { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
        const settled = Promise.withResolvers<ResponseBody>();
        const timer = setTimeout(() => { settled.resolve({ kind: "accepted" }); }, ABORT_TIMEOUT_MS);
        void (async (): Promise<void> => {
          try { await conversation.abort(BACKGROUND_CONTEXT); await flush(); settled.resolve({ kind: "accepted" }); }
          catch (error) { const native = errorSummary(error); settled.resolve({ kind: "rejected", code: "error", reason: native.message, native }); }
        })();
        try { return await settled.promise; } finally { clearTimeout(timer); }
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
  return session;

  async function flush(): Promise<void> {
    let current = draining;
    while (current !== undefined) { await current; current = draining; }
  }
}
