import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installedSessionCapabilities, openVoyage, type Event, type Session, type SessionOptions, type VoyageRecorder } from "../../packages/oar/src/index.js";
import { allRuntimes } from "../../sea-trial/harness/runtimes.js";
import { AgentBudget, handoff, openedState } from "./budget.js";
import { Contracts, type Op } from "./contracts.js";
import { Deliveries } from "./deliveries.js";
import type { AgentState, Message, Store } from "./store.js";
import { messageOf, openWithRules, preamble, processesIn, Serial, statusLine, type AgentOptions, type AgentStatusLine } from "./support.js";

/**
 * One long-lived agent: an OAR session that receives channel messages the way
 * a Raft agent does and answers only through its `harbor` executable.
 * Opening, closing and restarting run one at a time, and events from any
 * session but the current root are ignored, so a late exit cannot tear down
 * its successor. Everything the runtime does is in the voyage log; everything
 * harbor notices is in the journal.
 */
export class HarborAgent {
  private session: Session | null = null;
  private recorder: VoyageRecorder | null = null;
  private unsubscribe: (() => void) | null = null;
  private voyage: string | null = null;
  /** Lifecycle steps run one at a time, each after the previous settled. */
  private readonly lifecycle = new Serial();
  private starting = false;
  /** False once `close()` was asked for: nothing reopens after that. */
  private wanted = true;
  private openedAt = 0;
  private quickExits = 0;
  private openFailures = 0;
  private turns = 0;
  private turnStartedAt: number | null = null;
  private lastOutcome: string | null = null;
  private readonly budget: AgentBudget;
  /** Set by a recycle until a fresh session opens, so a retry after a failed open stays fresh and keeps the handoff. */
  private fresh: { readonly handoff: string | null } | null = null;
  private readonly contracts: Contracts;
  private readonly deliveries: Deliveries;
  state: AgentState;

  constructor(state: AgentState, private readonly store: Store, private readonly options: AgentOptions, private readonly onState: () => void) {
    this.state = state;
    this.budget = new AgentBudget(options.recycle, options.dayTokens, {
      name: state.name, store, state: (): AgentState => this.state,
      setState: (next): void => { this.state = next; this.onState(); },
      resume: (): void => { this.deliveries.resume(); },
    });
    this.contracts = new Contracts({
      name: state.name, store, stallMs: options.stallMs, session: (): Session | null => this.session, opens: (): number => this.state.opens,
      finding: (check, detail): void => { this.finding(check, detail); },
    });
    this.deliveries = new Deliveries({
      name: state.name, cwd: this.cwd, bin: options.bin, store,
      current: (): Session | null => this.session,
      // Judged before every delivery, so held work is checked when it is sent, not when it arrived.
      ready: (nextSeq): boolean => this.budget.ready(this.session, async () => {
        // Raft's constructed initial context: a fresh session whose first delivery carries a handoff, kept until one opens.
        this.fresh = { handoff: handoff(this.store.messages(), this.name, nextSeq) };
        await this.lifecycle.run(async () => { await this.closeNow("recycle"); await this.openNow(true); });
      }),
      finding: (check, detail): void => { this.finding(check, detail); },
      outstanding: (undelivered): void => { this.state = { ...this.state, undelivered }; this.onState(); },
    });
    this.deliveries.restore(state.undelivered ?? [], store.messages());
  }

  get name(): string {
    return this.state.name;
  }

  get cwd(): string {
    return this.state.cwd ?? join(this.store.agentDir(this.state.name), "work");
  }

  async open(fresh = false): Promise<void> {
    await this.lifecycle.run(async () => {
      await this.openNow(fresh);
    });
  }

  /** Dispose the session as a host restart would, check for leftovers, then reopen (resuming unless `fresh`). */
  async restart(fresh: boolean): Promise<void> {
    this.store.journal({ agent: this.name, kind: "restart", fresh });
    await this.lifecycle.run(async () => {
      await this.closeNow("restart");
      this.wanted = true;
      await this.openNow(fresh);
    });
  }

  async close(): Promise<void> {
    this.wanted = false;
    await this.lifecycle.run(async () => {
      await this.closeNow("down");
    });
  }

  deliver(message: Message, fromPerson: boolean): void {
    this.deliveries.add(message, fromPerson);
  }

  /** The agent posted to the channel: whatever it was asked has an answer. */
  replied(): void {
    this.deliveries.awaitingReply = false;
  }

  private async openNow(requested: boolean): Promise<void> {
    const fresh = requested || this.fresh !== null;
    if (this.session !== null || !this.wanted) {
      return;
    }
    this.starting = true;
    try {
      const resume = fresh ? null : this.state.sessionId ?? null;
      if (resume !== null) {
        try {
          await this.openSession(resume);
          return;
        } catch (error) {
          this.finding("resume_failed", { sessionId: resume, error: messageOf(error) });
        }
      }
      await this.openSession(null, this.fresh?.handoff ?? null);
      this.fresh = null;
    } catch (error) {
      this.openFailures += 1;
      this.finding("open_failed", { error: messageOf(error), attempt: this.openFailures });
      this.reopenLater(this.openFailures < 5 ? 60_000 : null, false);
    } finally {
      this.starting = false;
    }
  }

  private async openSession(resume: string | null, constructed: string | null = null): Promise<void> {
    const runtime = allRuntimes.require(this.state.runtime);
    const env = this.state.env;
    const installation = await runtime.installation?.(env === undefined ? {} : { env });
    if (installation?.kind !== "available") {
      throw new Error(`${this.state.runtime} is not available on this machine (${installation?.kind ?? "no probe"})`);
    }
    mkdirSync(this.cwd, { recursive: true });
    const startedAt = Date.now();
    const options = { ...(this.state.model === undefined ? {} : { model: this.state.model }), ...(this.state.effort === undefined ? {} : { effort: this.state.effort }) };
    // Only the agent's own `env`, never harbor's: cursor's in-process mode refuses one and codex's login shell reorders PATH, so agents run harbor by absolute path.
    const base: SessionOptions = { cwd: this.cwd, ...options, ...(resume === null ? {} : { resume }), ...(env === undefined ? {} : { env }) };
    const { session, rulesInPrompt, refusal } = await openWithRules(runtime, installation, base, preamble(this.name, this.cwd, this.options.bin));
    if (refusal !== undefined) {
      this.store.journal({ agent: this.name, kind: "rules_in_messages", refusal });
    }
    const opens = this.state.opens + 1;
    const voyage = `agents/${this.name}/session-${opens}.voyage.jsonl`;
    const recorder = openVoyage(join(this.store.dir, voyage), { runtime: this.state.runtime, ...options, cwd: this.cwd, sessionId: session.id, startedAt, recorder: "oar-harbor" });
    this.session = session;
    this.recorder = recorder;
    this.voyage = voyage;
    this.openedAt = Date.now();
    this.turns = 0;
    this.turnStartedAt = null;
    this.budget.opened(session);
    this.contracts.opened(session, installedSessionCapabilities(runtime, installation));
    this.openFailures = 0;
    const unRaw = session.rawEvents((record) => {
      recorder.record(record);
    }, { sessionId: session.id, afterSeq: -1 });
    const unEvents = session.events((event) => {
      if (this.session === session && event.kind === "usage") {
        this.budget.count(session);
      }
      if (this.session === session && event.sessionId === session.id && event.agentPath.length === 0) {
        this.observe(event);
      }
    });
    this.unsubscribe = (): void => {
      unRaw();
      unEvents();
    };
    this.state = openedState(this.state, session.id, opens, resume !== null);
    this.onState();
    this.store.journal({ agent: this.name, kind: resume === null ? "opened" : "resumed", sessionId: session.id, ms: Date.now() - startedAt, voyage });
    this.deliveries.opened(resume === null, rulesInPrompt, constructed);
  }

  private observe(event: Event): void {
    if (event.kind === "turn_started" || (event.kind === "turn_active" && this.turnStartedAt === null)) {
      this.turns += 1;
      this.turnStartedAt = event.receivedAt;
      this.store.journal({ agent: this.name, kind: event.kind, session: this.state.opens, turn: this.turns, seq: event.seq });
    } else if (event.kind === "turn_ended") {
      const ms = this.turnStartedAt === null ? null : event.receivedAt - this.turnStartedAt;
      this.turnStartedAt = null;
      this.budget.turnEnded(this.session, event.receivedAt);
      if (this.session !== null) { this.contracts.turnEnded(this.session, event); }
      this.lastOutcome = event.outcome.kind;
      const reason = event.outcome.kind === "failed" ? { reason: event.outcome.reason } : {};
      this.store.journal({ agent: this.name, kind: "turn_ended", session: this.state.opens, turn: this.turns, seq: event.seq, outcome: event.outcome.kind, ms, ...reason });
      if (event.outcome.kind === "failed") {
        this.finding("turn_failed", { session: this.state.opens, turn: this.turns, seq: event.seq, ...reason });
      }
      this.deliveries.turnEnded(event);
    } else if (event.kind === "input_dropped") {
      this.deliveries.dropped(event);
    } else if (event.kind === "exited") {
      this.exited(event.seq, event.code, event.reason);
    } else if (event.kind === "control_rejected" || event.kind === "retry" || event.kind === "compaction_started" || event.kind === "compaction_ended") {
      this.store.journal({ agent: this.name, ...event });
      if (event.kind === "compaction_ended") {
        this.deliveries.compacted();
      }
    }
  }

  private exited(seq: number, code: number | null, reason: string | undefined): void {
    this.store.journal({ agent: this.name, kind: "exited", seq, code, ...(reason === undefined ? {} : { reason }) });
    this.finding("unexpected_exit", { seq, code, reason: reason ?? null });
    this.release("exited");
    this.quickExits = Date.now() - this.openedAt < 30_000 ? this.quickExits + 1 : 0;
    const fresh = this.quickExits >= 2;
    if (fresh) {
      this.finding("resume_loop", { exits: this.quickExits, note: "the session exited within 30 s of opening twice; opening a fresh one" });
      this.quickExits = 0;
    }
    this.reopenLater(5000, fresh);
  }

  private reopenLater(ms: number | null, fresh: boolean): void {
    if (ms === null) {
      this.finding("gave_up", { note: "opening failed 5 times in a row; run harbor restart" });
      return;
    }
    setTimeout(() => {
      void this.reopen(fresh);
    }, ms);
  }

  private async reopen(fresh: boolean): Promise<void> {
    if (!this.wanted || this.session !== null) {
      return;
    }
    try {
      await this.open(fresh);
    } catch {
      // openNow journals its own failures
    }
  }

  private async closeNow(why: string): Promise<void> {
    const session = this.session;
    if (session === null) {
      return;
    }
    // Detach first: the exit this dispose causes is expected and must not reopen anything.
    this.release(why);
    try {
      await session.dispose();
    } catch (error) {
      this.finding("dispose_failed", { error: messageOf(error) });
    }
    const leftovers = processesIn(this.cwd);
    if (leftovers.length > 0) {
      this.finding("leftover_processes", { pids: leftovers });
    }
  }

  /** Detach from the current session; its later events are ignored, and inputs it accepted but never consumed go back to the inbox. */
  private release(why: string): void {
    if (this.session !== null) { this.budget.count(this.session); }
    this.recorder?.end(why);
    this.recorder = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session = null;
    this.turnStartedAt = null;
    this.deliveries.sessionGone(why);
  }

  /** Called by the daemon's watchdog. */
  tick(now: number): void { this.contracts.tick(now); }

  /** A QA operation on the current session (`harbor op`), checked against what OAR promises. */
  async op(op: Op, arg?: string): Promise<Record<string, unknown>> { const result = await this.contracts.run(op, arg); return result; }

  status(now: number): AgentStatusLine {
    return statusLine({ session: this.session, state: this.state, starting: this.starting, turnStartedAt: this.turnStartedAt, turns: this.turns, lastOutcome: this.lastOutcome, pending: this.deliveries.pending, awaitingReply: this.deliveries.awaitingReply }, now);
  }

  private finding(check: string, detail: Record<string, unknown>): void {
    this.store.journal({ agent: this.name, kind: "finding", check, voyage: this.voyage, ...detail });
  }
}
