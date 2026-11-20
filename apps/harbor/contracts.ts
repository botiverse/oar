import type { Event, Session, SessionCapabilityDeclaration } from "../../packages/oar/src/index.js";
import type { Store } from "./store.js";
import { messageOf } from "./support.js";

export interface ContractsHost {
  readonly name: string;
  readonly store: Store;
  readonly stallMs: number;
  session(): Session | null;
  opens(): number;
  finding(check: string, detail: Record<string, unknown>): void;
}

/** The operations a QA sender can run on an agent's session (`harbor op`). */
export const OPS = ["abort", "steer", "compact", "stop-task", "usage", "breakdown"] as const;
export type Op = (typeof OPS)[number];

export function isOp(value: string): value is Op {
  return OPS.some((name) => name === value);
}

/** How long an accepted abort may take to end the turn before it is a finding. */
const ABORT_SETTLES_MS = 30_000;

/**
 * Harbor's checks of OAR's own promises, judged from what OAR returns and
 * records rather than from what an agent says: a session's members match the
 * installation's declaration, completed turns report what the declaration
 * promises, usage never goes down, an accepted abort ends the turn, a running
 * turn keeps producing records. A broken promise is a finding.
 */
export class Contracts {
  private declared: SessionCapabilityDeclaration = {};
  private lastTokens = 0;
  /** The current turn compacted: its context may be unknown until the next model response, as `ContextUsage` allows. */
  private compactedThisTurn = false;
  private readonly stalled = new Set<string>();

  constructor(private readonly host: ContractsHost) {}

  /** A session opened: its members must match what the installation declared before open. */
  opened(session: Session, declared: SessionCapabilityDeclaration): void {
    this.declared = declared;
    this.lastTokens = 0;
    // A compaction in the previous session's unfinished turn says nothing about this one.
    this.compactedThisTurn = false;
    const checks: [string, boolean | undefined, boolean][] = [
      ["steer", declared.steer, session.steer !== undefined],
      ["stopTask", declared.stopTask, session.stopTask !== undefined],
      ["images", declared.images, session.capabilities.images],
      ["manualCompaction", declared.manualCompaction === undefined ? undefined : declared.manualCompaction.kind === "supported", session.compact !== undefined],
    ];
    for (const [field, expected, actual] of checks) {
      if (expected !== undefined && expected !== actual) {
        this.host.finding("declaration_mismatch", { session: this.host.opens(), field, declared: expected, opened: actual });
      }
    }
  }

  /** Every root event of the current session. */
  event(session: Session, event: Event): void {
    if (event.kind === "compaction_ended") {
      this.compactedThisTurn = true;
    } else if (event.kind === "turn_ended") {
      this.turnEnded(session, event);
      this.compactedThisTurn = false;
    }
  }

  /** A root turn ended: what a completed turn promises to report, and usage that only grows. */
  private turnEnded(session: Session, event: Extract<Event, { kind: "turn_ended" }>): void {
    const total = session.usage().value.total;
    const tokens = total === null ? 0 : total.input + total.output;
    if (tokens < this.lastTokens) {
      this.host.finding("usage_decreased", { session: this.host.opens(), seq: event.seq, before: this.lastTokens, after: tokens });
    }
    this.lastTokens = Math.max(this.lastTokens, tokens);
    if (event.outcome.kind !== "completed") {
      return;
    }
    const context = session.contextUsage().value;
    const promised = this.declared.contextUsage;
    if (promised?.tokens === true && !this.compactedThisTurn && (context?.tokens ?? null) === null) {
      this.host.finding("context_usage_missing", { session: this.host.opens(), seq: event.seq, field: "tokens" });
    }
    if (promised?.contextWindow === true && (context?.contextWindow ?? null) === null) {
      this.host.finding("context_usage_missing", { session: this.host.opens(), seq: event.seq, field: "contextWindow" });
    }
  }

  /** Called by the daemon's watchdog: a running turn silent for `stallMs` is reported once. */
  tick(now: number): void {
    const status = this.host.session()?.status().value;
    if (status?.kind !== "running" || now - status.lastEventAt <= this.host.stallMs) {
      return;
    }
    const key = `${String(this.host.opens())}:${String(status.sinceSeq)}`;
    if (!this.stalled.has(key)) {
      this.stalled.add(key);
      this.host.finding("stalled", { session: this.host.opens(), sinceSeq: status.sinceSeq, silentMs: now - status.lastEventAt, phase: status.phase });
    }
  }

  /** Runs one operation on the current session, journals what OAR returned, and checks what it promised. */
  async run(op: Op, arg: string | undefined): Promise<Record<string, unknown>> {
    const session = this.host.session();
    if (session === null) {
      return { op, result: "no_session" };
    }
    const started = Date.now();
    const before = session.status().value.kind;
    const result = await this.dispatch(session, op, arg).catch((error: unknown) => ({ threw: messageOf(error) }));
    const entry = { op, ...(arg === undefined ? {} : { arg }), before, ms: Date.now() - started, ...result };
    this.host.store.journal({ agent: this.host.name, kind: "op", session: this.host.opens(), ...entry });
    return entry;
  }

  private async dispatch(session: Session, op: Op, arg: string | undefined): Promise<Record<string, unknown>> {
    if (op === "abort") {
      return this.abort(session);
    }
    if (op === "steer") {
      if (session.steer === undefined) {
        return { result: "absent" };
      }
      const steered = await session.steer(arg ?? "(harbor steer)");
      return { response: steered.response.body };
    }
    if (op === "compact") {
      if (session.compact === undefined) {
        return { result: "absent" };
      }
      const contextBefore = session.contextUsage().value?.tokens ?? null;
      const outcome = await session.compact({ timeoutMs: 300_000 });
      const { kind } = outcome;
      return { outcome: kind, ...("code" in outcome ? { code: outcome.code, reason: outcome.reason } : {}), contextBefore, contextAfter: session.contextUsage().value?.tokens ?? null };
    }
    if (op === "stop-task") {
      if (session.stopTask === undefined) {
        return { result: "absent" };
      }
      const stopped = await session.stopTask(arg ?? "");
      return { response: stopped.response.body };
    }
    if (op === "usage") {
      return { usage: session.usage().value, context: session.contextUsage().value, status: session.status().value };
    }
    return { breakdown: session.contextBreakdown === undefined ? "absent" : await session.contextBreakdown() };
  }

  /** An accepted abort must end the active turn; a rejected one while running is reported for review. */
  private async abort(session: Session): Promise<Record<string, unknown>> {
    const ended = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => { ended.resolve(false); }, ABORT_SETTLES_MS);
    const unsubscribe = session.events((event) => {
      if (event.kind === "turn_ended" && event.agentPath.length === 0) {
        ended.resolve(true);
      }
    });
    const wasRunning = session.status().value.kind === "running";
    const aborted = await session.abort();
    const body = aborted.response.body;
    if (body.kind !== "accepted") {
      clearTimeout(timer);
      unsubscribe();
      if (wasRunning) {
        this.host.finding("abort_rejected_while_running", { session: this.host.opens(), response: body });
      }
      return { response: body };
    }
    const settled = await ended.promise;
    clearTimeout(timer);
    unsubscribe();
    if (!settled) {
      this.host.finding("abort_without_turn_end", { session: this.host.opens(), waitedMs: ABORT_SETTLES_MS });
    }
    return { response: body, turnEnded: settled };
  }
}
