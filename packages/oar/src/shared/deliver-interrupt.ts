import type { ControlOutcome, DeliverMergeInput, DeliverMergeResult, DeliverOptions, DeliverResult, RawEvent, RejectionCode, Session } from "../contracts/session.js";
import { conversationOf } from "../observe/conversation.js";

type InterruptOptions = Extract<DeliverOptions, { when: "interrupt" }> & { readonly inputId: string };
type BatchResult = Omit<Extract<DeliverResult, { landed: "rejected" }>, "inputId"> | {
  readonly landed: "prompted"; readonly result: ControlOutcome; readonly mergedInputIds: readonly string[];
};
const batches = new WeakMap<Session, InterruptBatch>();

export function pendingInterrupt(session: Session): InterruptBatch | undefined { return batches.get(session); }

export async function interruptInto(session: Session, input: string, options: InterruptOptions): Promise<DeliverResult> {
  if (session.withdraw === undefined) {
    return { landed: "rejected", inputId: options.inputId, code: "unsupported", reason: "interrupt requires withdrawal of held inputs", undeliveredInputIds: [options.inputId] };
  }
  const batch = new InterruptBatch(session, options);
  batches.set(session, batch);
  const result = await batch.join(input, options);
  return result;
}

function mergeInputs(inputs: readonly DeliverMergeInput[]): DeliverMergeResult {
  const images = inputs.flatMap((input) => input.images ?? []);
  return { input: inputs.map((input) => input.input).join("\n\n"), ...(images.length === 0 ? {} : { images }) };
}

/** An ephemeral control operation. Inputs, ownership and tool boundaries remain facts of the record stream. */
class InterruptBatch {
  private readonly completion = Promise.withResolvers<BatchResult>();
  readonly done = this.completion.promise;
  private readonly ended = Promise.withResolvers<void>();
  private readonly tools = new Set<string>();
  private readonly queued: Promise<ControlOutcome>[] = [];
  private readonly withdrawals = new Map<string, { readonly input: DeliverMergeInput; readonly result: Promise<ControlOutcome> }>();
  private readonly stop: () => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline = Infinity;
  private collecting = false;
  private nativeEnd = false;
  private exited = false;
  private released = false;
  private disposed = false;
  private ready = false;
  private settled = 0;
  private readonly since: number;

  constructor(private readonly session: Session, private readonly options: InterruptOptions) {
    const status = session.status().value;
    this.since = status.kind === "running" ? status.sinceSeq : -1;
    for (const record of session.records()) { this.track(record); }
    this.stop = session.rawEvents((record) => {
      this.track(record);
      // Withdraw synchronously before the adapter can drain on natural end.
      if (this.nativeEnd || this.exited || this.released || this.disposed || (this.ready && this.tools.size === 0)) { this.collect(); }
    });
  }

  accepting(): boolean { return !this.collecting; }

  async join(input: string, options: InterruptOptions): Promise<DeliverResult> {
    const { when: _when, maxWaitMs, merge: _merge, ...inputOptions } = options;
    this.deadline = Math.min(this.deadline, Date.now() + maxWaitMs);
    const pending = this.session.queue(input, inputOptions);
    this.queued.push(pending);
    const queued = await pending;
    this.settled += 1;
    if (queued.kind === "rejected") {
      if (!this.ready && this.settled === this.queued.length && !this.collecting) { this.finish(this.failure(queued.code, queued.reason, [options.inputId], queued)); }
      return { ...this.failure(queued.code, queued.reason, [options.inputId], queued), inputId: options.inputId };
    }
    this.ready = true;
    if (!this.collecting) {
      clearTimeout(this.timer);
      if (this.tools.size === 0 || Date.now() >= this.deadline) { this.collect(); }
      else { this.timer = setTimeout(() => { this.collect(); }, this.deadline - Date.now()); }
    }
    const outcome = await this.done;
    const included = outcome.landed === "prompted" ? outcome.mergedInputIds : outcome.undeliveredInputIds ?? [];
    // A queue already dispatched at the natural boundary remains runtime-owned.
    // Never tell a caller to resend an accepted input we could not withdraw.
    return included.includes(options.inputId)
      ? { ...outcome, inputId: options.inputId }
      : { landed: "queued", inputId: options.inputId, result: queued,
        ...(outcome.landed === "prompted" ? { mergedInputIds: outcome.mergedInputIds } : { undeliveredInputIds: outcome.undeliveredInputIds ?? [] }) };
  }

  private track(record: RawEvent): void {
    if (record.sessionId !== this.session.id || record.agentPath.length > 0 || record.seq < this.since) { return; }
    if (record.kind === "response" && record.body.kind === "exited") { this.exited = true; this.ended.resolve(); }
    if (record.kind === "response" && record.body.kind === "released") { this.released = true; this.ended.resolve(); }
    if (record.kind === "request" && record.direction === "toRuntime" && record.body.kind === "dispose") { this.disposed = true; this.ended.resolve(); }
    if (record.kind !== "frame") { return; }
    for (const event of record.body.events) {
      if (event.kind === "tool_call_started") { this.tools.add(event.callId); }
      if (event.kind === "tool_call_ended") { this.tools.delete(event.callId); }
      if (event.kind === "turn_ended") { this.nativeEnd = true; this.ended.resolve(); }
    }
  }

  private takeHeld(): void {
    const withdraw = this.session.withdraw?.bind(this.session);
    if (withdraw === undefined) { return; }
    const inputs = [...conversationOf(this.session.records()).inputs.values()].toSorted((a, b) => (a.attempts.at(-1)?.request.seq ?? 0) - (b.attempts.at(-1)?.request.seq ?? 0));
    for (const input of inputs) {
      const last = input.attempts.at(-1);
      if (input.inputId === undefined || this.withdrawals.has(input.inputId) || last?.request.body.kind !== "queue"
        || last.state === "rejected" || last.request.sessionId !== this.session.id || last.request.agentPath.length > 0
        || input.state === "dropped") { continue; }
      const value: DeliverMergeInput = { inputId: input.inputId, input: input.input, ...(input.images === undefined ? {} : { images: input.images }), ...(input.origin === undefined ? {} : { origin: input.origin }) };
      // Each call removes its entry synchronously; never await between entries.
      this.withdrawals.set(input.inputId, { input: value, result: withdraw(input.inputId) });
    }
  }

  private collect(): void {
    if (this.collecting) { return; }
    this.collecting = true;
    clearTimeout(this.timer);
    this.takeHeld();
    void this.send();
  }

  private async send(): Promise<void> {
    let inputs: DeliverMergeInput[] = [];
    try {
      await Promise.all(this.queued);
      this.takeHeld();
      const taken = await Promise.all([...this.withdrawals.values()].map(async (entry) => ({ input: entry.input, result: await entry.result })));
      inputs = taken.filter((entry) => entry.result.kind === "accepted" || (entry.result.code === "runtime_exited" || entry.result.code === "disposed" || entry.result.code === "session_released")).map((entry) => entry.input);
      const failure = taken.find((entry) => entry.result.kind === "rejected" && entry.result.code !== "not_queued");
      if (failure?.result.kind === "rejected") {
        this.finish(this.failure(failure.result.code, failure.result.reason, inputs.map((value) => value.inputId), failure.result));
        return;
      }
      if (inputs.length === 0) {
        this.finish(this.failure("not_queued", "no held inputs remain to interrupt for", []));
        return;
      }
      const result = await this.afterWithdrawal(inputs);
      this.finish(result);
    } catch (error) {
      this.finish(this.failure("error", error instanceof Error ? error.message : String(error), inputs.map((value) => value.inputId)));
    }
  }

  private async afterWithdrawal(inputs: readonly DeliverMergeInput[]): Promise<BatchResult> {
    const ids = inputs.map((input) => input.inputId);
    if (!this.nativeEnd && !this.exited && !this.released && !this.disposed) {
      const aborted = await this.session.abort();
      if (aborted.kind === "rejected" && !this.hasEnded()) { return this.failure(aborted.code, aborted.reason, ids, aborted); }
    }
    if (!this.nativeEnd && !this.exited && !this.released && !this.disposed) { await this.ended.promise; }
    if (this.exited || this.released || this.disposed || !this.nativeEnd) {
      return this.failure(this.disposed ? "disposed" : (this.released && !this.exited ? "session_released" : "runtime_exited"), "runtime did not remain available after its own turn end; inputs were not redelivered", ids);
    }
    const merged = (this.options.merge ?? mergeInputs)(inputs);
    const result = await this.session.prompt(merged.input, { ...(merged.images === undefined ? {} : { images: merged.images }), carries: ids });
    return result.kind === "accepted"
      ? { landed: "prompted", result, mergedInputIds: ids }
      : this.failure(result.code, result.reason, ids, result);
  }

  private hasEnded(): boolean { return this.nativeEnd; }

  private failure(code: RejectionCode, reason: string, ids: readonly string[], result?: ControlOutcome): Extract<BatchResult, { landed: "rejected" }> {
    return { landed: "rejected", code, reason, undeliveredInputIds: ids, ...(result === undefined ? {} : { result }) };
  }

  private finish(result: BatchResult): void {
    clearTimeout(this.timer);
    this.stop();
    batches.delete(this.session);
    this.completion.resolve(result);
  }
}
