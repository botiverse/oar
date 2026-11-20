import type { Session, SessionUsage } from "../../packages/oar/src/index.js";
import type { AgentState, Message, Store } from "./store.js";
import { formatMessage } from "./support.js";

/**
 * Raft's constructed-initial-context rule, applied to harbor: a session that
 * sat idle past `idleMs` with more than `contextTokens` in its context is not
 * resumed for the next message. A fresh one starts with a short handoff
 * instead, so one long conversation does not make every later model call
 * re-read the whole history.
 */
export interface RecyclePolicy {
  readonly idleMs: number;
  readonly contextTokens: number;
}

export function shouldRecycle(policy: RecyclePolicy | null, idleMs: number | null, contextTokens: number | null): boolean {
  return policy !== null && idleMs !== null && contextTokens !== null && idleMs > policy.idleMs && contextTokens > policy.contextTokens;
}

/** A whole number of at least `min`; anything else stops `up` before it starts, so a typo never silently turns a limit off. */
export function limitValue(flag: string, value: string | undefined, fallback: number, min: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(`--${flag} needs a whole number of at least ${String(min)}, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** Raft's defaults: an hour idle and 128K of context; `--recycle-idle-min 0` turns recycling off. */
export function recyclePolicy(idleMin: string | undefined, context: string | undefined): RecyclePolicy | null {
  const idleMs = limitValue("recycle-idle-min", idleMin, 60, 0) * 60_000;
  const contextTokens = limitValue("recycle-context", context, 128_000, 1);
  return idleMs === 0 ? null : { idleMs, contextTokens };
}

/** About 10K tokens, as Raft's constructed context. */
const HANDOFF_CHARS = 40_000;
const TRUNCATED = " [truncated; harbor read shows it whole]";

/** The constructed context: the newest channel messages this agent sent or received before `beforeSeq`, oldest first, within the budget. */
export function handoff(messages: readonly Message[], name: string, beforeSeq: number, maxChars = HANDOFF_CHARS): string | null {
  const lines: string[] = [];
  let used = 0;
  for (const message of messages.toReversed()) {
    if (message.seq >= beforeSeq || (message.from !== name && !message.to.includes(name))) {
      continue;
    }
    const full = formatMessage(message);
    // An oversized newest message still leaves an excerpt rather than no handoff at all.
    const line = lines.length === 0 && full.length > maxChars ? `${full.slice(0, maxChars - TRUNCATED.length)}${TRUNCATED}` : full;
    if (used + line.length > maxChars) {
      break;
    }
    lines.unshift(line);
    used += line.length + 1;
  }
  if (lines.length === 0) {
    return null;
  }
  return [
    "(harbor: your previous session sat idle with a large context, so this is a fresh session. These are the latest channel messages you sent or received, oldest first; run harbor read for older ones. Files you wrote are still in your working directory.)",
    ...lines,
    "(harbor: end of the earlier messages; new ones follow.)",
  ].join("\n");
}

/** Tokens a session has reported so far, its children included: input already counts cache reads and writes. */
export function sessionTokens(usage: SessionUsage): number {
  const totals = usage.withChildren ?? usage.total;
  return totals === null ? 0 : totals.input + totals.output;
}

/** One agent's tokens in the current UTC day. */
export interface DayTokens {
  readonly day: string;
  readonly tokens: number;
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Adds `tokens` to the day's count, starting over on a new UTC day. */
export function addDayTokens(current: DayTokens | undefined, tokens: number, now: number): DayTokens {
  const day = utcDay(now);
  return { day, tokens: (current?.day === day ? current.tokens : 0) + tokens };
}

export function dayExhausted(current: DayTokens | undefined, max: number | null, now: number): boolean {
  return max !== null && current?.day === utcDay(now) && current.tokens >= max;
}

export function msUntilNextDay(now: number): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now;
}

/** The agent's state after an open: a fresh session drops the old session's context size. */
export function openedState(state: AgentState, sessionId: string, opens: number, resumed: boolean): AgentState {
  const { contextTokens, ...kept } = state;
  return { ...kept, sessionId, opens, ...(resumed && contextTokens !== undefined ? { contextTokens } : {}) };
}

export interface BudgetHost {
  readonly name: string;
  readonly store: Store;
  state(): AgentState;
  setState(state: AgentState): void;
  /** Deliveries may flow again. */
  resume(): void;
}

/** One agent's recycle clock and daily token count; deliveries are held while `holding`. */
export class AgentBudget {
  recycling = false;
  private paused = false;
  private openedAt = 0;
  private lastTurnEndedAt: number | null = null;
  /** Tokens the session had reported when they were last added to the day's count. */
  private counted = 0;

  constructor(private readonly policy: RecyclePolicy | null, private readonly dayTokens: number | null, private readonly host: BudgetHost) {
    // A cap already reached today, before a harbor restart, still holds.
    this.holdIfExhausted(Date.now());
  }

  get holding(): boolean {
    return this.recycling || this.paused;
  }

  opened(session: Session): void {
    this.openedAt = Date.now();
    this.lastTurnEndedAt = null;
    this.counted = sessionTokens(session.usage().value);
  }

  /** Since the last turn ended, or since the session opened when none has (a resume after a harbor restart). */
  idleMs(): number {
    return Date.now() - (this.lastTurnEndedAt ?? this.openedAt);
  }

  stale(session: Session | null): boolean {
    if (this.recycling || session === null || session.status().value.kind !== "idle") {
      return false;
    }
    return shouldRecycle(this.policy, this.idleMs(), session.contextUsage().value?.tokens ?? this.host.state().contextTokens ?? null);
  }

  /** Adds what the session reported since the last count (children included), whenever it reports or closes. */
  count(session: Session): void {
    const tokens = sessionTokens(session.usage().value);
    const now = Date.now();
    const dayTokens = addDayTokens(this.host.state().dayTokens, Math.max(0, tokens - this.counted), now);
    this.counted = Math.max(this.counted, tokens);
    const contextTokens = session.contextUsage().value?.tokens;
    this.host.setState({ ...this.host.state(), dayTokens, ...(contextTokens === undefined || contextTokens === null ? {} : { contextTokens }) });
    this.holdIfExhausted(now);
  }

  /** Past the day's cap, deliveries wait for the next UTC day; true while held. */
  private holdIfExhausted(now: number): boolean {
    const dayTokens = this.host.state().dayTokens;
    if (this.paused || !dayExhausted(dayTokens, this.dayTokens, now)) {
      return this.paused;
    }
    this.paused = true;
    const resumeInMs = msUntilNextDay(now);
    this.host.store.journal({ agent: this.host.name, kind: "limit", limit: "day_tokens", tokens: dayTokens?.tokens, max: this.dayTokens, resumeInMs });
    setTimeout(() => {
      // Usage that landed after midnight may already fill the new day: check again before letting work through.
      this.paused = false;
      if (!this.holdIfExhausted(Date.now())) {
        this.host.store.journal({ agent: this.host.name, kind: "resumed_after_limit", limit: "day_tokens" });
        this.host.resume();
      }
    }, resumeInMs);
    return true;
  }

  /** May a delivery start? Not while held; a stale session is replaced first by `reopen`, and deliveries resume after it. */
  ready(session: Session | null, reopen: () => Promise<void>): boolean {
    if (this.holding) {
      return false;
    }
    if (!this.stale(session)) {
      return true;
    }
    void this.recycle(session, reopen);
    return false;
  }

  private async recycle(session: Session | null, reopen: () => Promise<void>): Promise<void> {
    this.recycling = true;
    this.host.store.journal({ agent: this.host.name, kind: "recycle", session: this.host.state().opens, idleMs: this.idleMs(), contextTokens: session?.contextUsage().value?.tokens ?? null });
    try {
      await reopen();
    } finally {
      this.recycling = false;
      this.host.resume();
    }
  }

  turnEnded(session: Session | null, at: number): void {
    this.lastTurnEndedAt = at;
    if (session !== null) {
      this.count(session);
    }
  }
}
