import type { Event, Session } from "../../packages/oar/src/index.js";
import type { Message, Store } from "./store.js";
import { formatMessage, preamble, reminder } from "./support.js";

export interface DeliveriesHost {
  readonly name: string;
  readonly cwd: string;
  readonly bin: string;
  readonly store: Store;
  current(): Session | null;
  finding(check: string, detail: Record<string, unknown>): void;
}

interface Accepted {
  readonly batch: readonly Message[];
  readonly landed: "prompted" | "steered" | "queued";
}

/** Rejections that mean this session is gone: wait for the reopen instead of retrying. */
const SESSION_GONE = new Set(["runtime_exited", "disposed", "session_released", "session_not_found"]);
const MAX_ATTEMPTS = 5;

/**
 * Getting channel messages into one agent: in order, batched while a delivery
 * is in flight, through `Session.deliver` as a Raft Computer does. An input
 * the session accepted stays tracked until a turn consumes it; one the stream
 * hands back (`input_dropped`), or that a closed session never consumed, is
 * delivered again and journaled, never silently lost.
 */
export class Deliveries {
  private readonly inbox: Message[] = [];
  private readonly accepted = new Map<string, Accepted>();
  private readonly attempts = new Map<number, number>();
  /** Messages a person sent: only these expect an answer, not one agent's note to another. */
  private readonly fromPeople = new Set<number>();
  private pumping = false;
  private needsPreamble = false;
  private rulesInPrompt = false;
  /** Counts reported compactions, so one that lands while a delivery is in flight still brings the rules back. */
  private compactions = 0;
  awaitingReply = false;

  constructor(private readonly host: DeliveriesHost) {}

  get pending(): number {
    return this.inbox.length;
  }

  add(message: Message, fromPerson: boolean): void {
    if (fromPerson) {
      this.fromPeople.add(message.seq);
    }
    this.inbox.push(message);
    void this.pump();
  }

  /** A session opened; a fresh one has never seen the channel rules, unless they are in its system prompt. */
  opened(fresh: boolean, rulesInPrompt: boolean): void {
    this.rulesInPrompt = rulesInPrompt;
    this.needsPreamble = !rulesInPrompt && (this.needsPreamble || fresh);
    void this.pump();
  }

  /** A summary may have dropped the channel rules: the next delivery repeats them. */
  compacted(): void {
    this.compactions += 1;
    this.needsPreamble = !this.rulesInPrompt;
  }

  turnEnded(event: Extract<Event, { kind: "turn_ended" }>): void {
    const ids = event.inputIds ?? (event.inputId === undefined ? [] : [event.inputId]);
    for (const [inputId, entry] of this.accepted) {
      if (ids.length > 0 ? ids.includes(inputId) : entry.landed !== "queued") {
        this.accepted.delete(inputId);
      }
    }
    if (event.outcome.kind === "failed") {
      // turn_failed already names this turn; a silent agent after a failure is not a second finding.
      this.awaitingReply = false;
    }
    setTimeout(() => {
      this.settle(event.seq);
    }, 2000);
  }

  /** Two seconds after a turn: if the agent is idle, everything it held was consumed; did it answer? */
  private settle(seq: number): void {
    const session = this.host.current();
    if (session?.status().value.kind !== "idle" || this.inbox.length > 0) {
      return;
    }
    this.accepted.clear();
    if (this.awaitingReply) {
      this.awaitingReply = false;
      this.host.finding("no_reply", { seq, note: "went idle after a delivery without posting to the channel" });
    }
  }

  dropped(event: Extract<Event, { kind: "input_dropped" }>): void {
    const entry = event.inputId === undefined ? undefined : this.accepted.get(event.inputId);
    this.host.finding("input_dropped", { seq: event.seq, inputId: event.inputId ?? null, reason: event.reason, seqs: entry?.batch.map((message) => message.seq) ?? null });
    if (entry !== undefined && event.inputId !== undefined) {
      this.accepted.delete(event.inputId);
      this.inbox.unshift(...entry.batch);
      void this.pump();
    }
  }

  /** The session closed or exited: inputs it accepted and never consumed are delivered again to the next one. */
  sessionGone(why: string): void {
    const batches = [...this.accepted.values()].flatMap((entry) => entry.batch);
    this.accepted.clear();
    if (batches.length > 0) {
      this.host.store.journal({ agent: this.host.name, kind: "redelivering", why, seqs: batches.map((message) => message.seq) });
      this.inbox.unshift(...batches);
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      for (;;) {
        const session = this.host.current();
        if (session === null || this.inbox.length === 0) {
          return;
        }
        const batch = this.inbox.splice(0);
        // eslint-disable-next-line no-await-in-loop
        if (!(await this.send(session, batch))) {
          return;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** No system prompt to carry the channel rules: the full rules when they may be lost, else a one-line reminder. */
  private withRules(body: string): string {
    if (this.needsPreamble) {
      return `${preamble(this.host.name, this.host.cwd, this.host.bin)}\n\n${body}`;
    }
    return `${reminder(this.host.bin)}\n${body}`;
  }

  /** One delivery attempt; false stops the pump until the next open or message. */
  private async send(session: Session, batch: readonly Message[]): Promise<boolean> {
    const body = batch.map((message) => formatMessage(message)).join("\n");
    const text = this.rulesInPrompt ? body : this.withRules(body);
    const compactions = this.compactions;
    const seqs = batch.map((message) => message.seq);
    const started = Date.now();
    const result = await session.deliver(text);
    if (this.host.current() !== session) {
      // Restarted or exited during the call: the next session gets it.
      this.inbox.unshift(...batch);
      this.host.store.journal({ agent: this.host.name, kind: "redelivering", why: "session changed during delivery", seqs });
      return false;
    }
    if (result.landed !== "rejected") {
      if (this.compactions === compactions) {
        this.needsPreamble = false;
      }
      if (seqs.some((seq) => this.fromPeople.delete(seq))) {
        this.awaitingReply = true;
      }
      this.accepted.set(result.inputId, { batch, landed: result.landed });
      this.host.store.journal({ agent: this.host.name, kind: "delivered", seqs, landed: result.landed, inputId: result.inputId, ms: Date.now() - started });
      return true;
    }
    this.inbox.unshift(...batch);
    if (SESSION_GONE.has(result.code)) {
      this.host.store.journal({ agent: this.host.name, kind: "delivery_deferred", seqs, code: result.code });
      return false;
    }
    const attempt = (this.attempts.get(seqs[0] ?? 0) ?? 0) + 1;
    for (const seq of seqs) {
      this.attempts.set(seq, attempt);
    }
    this.host.finding("delivery_rejected", { seqs, code: result.code, reason: result.reason, attempt });
    if (attempt >= MAX_ATTEMPTS) {
      this.inbox.splice(0, batch.length);
      for (const seq of seqs) {
        this.fromPeople.delete(seq);
      }
      this.host.finding("delivery_dropped", { seqs, note: `rejected ${MAX_ATTEMPTS} times` });
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5000 * 2 ** (attempt - 1));
    });
    return true;
  }
}
