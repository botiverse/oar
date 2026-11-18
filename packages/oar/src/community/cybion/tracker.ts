import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeEventBody, TurnOutcome } from "../../contracts/records.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import type { CybionClient } from "./client.js";
import { eventsOfHistory, frameTypeOf } from "./projection.js";
import { readHistory, readThread, type CybionHistoryRecord, type CybionThread, type CybionUsage } from "./thread.js";

/** First wait between polls of a running Thread. */
const POLL_FIRST_MS = 250;
/** The longest wait between polls: a turn that runs for minutes costs one read a second. */
const POLL_MAX_MS = 2000;
/** Quiet polls after the Thread stopped running, before its turn is read as ended. */
const QUIET_POLLS = 2;
/** Polls a freshly accepted input gets to make the Thread run before its absent record decides. */
const START_POLLS = 8;
/** Consecutive failed reads after which an attached deployment is taken for gone. */
const UNREACHABLE_AFTER = 8;

interface Turn {
  readonly ended: PromiseWithResolvers<void>;
  /** The last history record this process recorded for this turn. */
  seen: number;
  /** The Thread was observed running, or a record appeared: this turn did work. */
  worked: boolean;
  quiet: number;
  startPolls: number;
}

export interface ThreadTracker {
  /** A turn runs in the Thread, or one waits behind it. */
  busy(): boolean;
  /** Follow the turn an accepted input started, whose own record is `recordIdx`. */
  follow(recordIdx: number | null): void;
  /** Resolves when the turn followed now has ended, or after `ms`. */
  settle(ms: number): Promise<void>;
  /** Stop following; nothing more is recorded. */
  close(): void;
}

export interface TrackerOptions {
  readonly client: CybionClient;
  readonly kernel: SessionKernel;
  readonly thread: CybionThread;
  /** The last history record this process already recorded, so a turn frames only its own. */
  readonly seen: number;
  /** Called after a turn ended with nothing left running. */
  readonly onIdle: () => void;
  /** Called when the deployment stops answering. */
  readonly onUnreachable: (() => void) | null;
}

/** The Thread's totals less the ones it already carried when this session opened. */
function totalsSince(now: CybionUsage, opened: CybionUsage): CybionUsage {
  return {
    input: Math.max(0, now.input - opened.input),
    output: Math.max(0, now.output - opened.output),
    cacheRead: Math.max(0, now.cacheRead - opened.cacheRead),
  };
}

function sameUsage(left: CybionUsage, right: CybionUsage): boolean {
  return left.input === right.input && left.output === right.output && left.cacheRead === right.cacheRead;
}

/** What one poll of the Thread says about the turn: running, quiet, or not yet started. */
function observe(current: Turn, now: CybionThread): void {
  if (now.status === "running") {
    current.worked = true;
    current.quiet = 0;
    return;
  }
  if (current.worked) {
    current.quiet += 1;
    return;
  }
  current.startPolls += 1;
}

/** How a Thread that stopped running ended, from Cybion's own status words. */
function outcomeOf(thread: CybionThread): TurnOutcome {
  if (thread.displayStatus === "stopped") {
    return { kind: "aborted" };
  }
  if (thread.status === "failed") {
    return { kind: "failed", failure: "unknown", reason: "the Cybion Thread failed; its own history holds the reason" };
  }
  if (thread.displayStatus === "blocked") {
    return { kind: "failed", failure: "limit_reached", reason: "the Cybion Thread is blocked on its owner" };
  }
  return { kind: "completed" };
}

/**
 * One OAR session is one Cybion Thread, followed through the Agent API
 * (`GET /v1/threads/{id}` and `/history`; docs/runtimes/cybion.md). Cybion's
 * surface streams nothing, so a turn is followed by polling:
 *
 * - Every history record past the ones this process already recorded becomes
 *   one frame carrying the record verbatim and the events read out of it
 *   (projection.ts). The history is append-only, so no record repeats.
 * - The Thread's own status says when the turn ended: `running` while it
 *   works, then a refined idle word (`completed`, `stopped`, `blocked`).
 *   The end is read only after two quiet polls, so a status write that lands
 *   a moment after the last record is not mistaken for a finished turn.
 * - Token totals are Cybion's own Thread totals, reported as the session's
 *   running total (what the Thread spent, less what it carried when the
 *   session opened), so no turn is counted twice.
 */
export function createThreadTracker(options: TrackerOptions): ThreadTracker {
  const { client, kernel, thread } = options;
  const opened = thread.usage;
  let turn: Turn | null = null;
  let closed = false;
  let pumping = false;
  let seen = options.seen;
  let reported: CybionUsage | null = null;
  let contextTokens = thread.contextTokens;
  let model = thread.model;

  const emitUsage = (now: CybionThread): void => {
    const totals = totalsSince(now.usage, opened);
    const changed = reported === null || !sameUsage(totals, reported);
    const events: RuntimeEventBody[] = changed
      ? [{ kind: "usage", usage: { tokens: { input: totals.input, output: totals.output, ...(totals.cacheRead === 0 ? {} : { cacheRead: totals.cacheRead }) } } }]
      : [];
    if (changed) {
      reported = totals;
    }
    const context = now.contextTokens;
    if (context !== null && context !== contextTokens) {
      events.push({ kind: "usage", usage: { context: { tokens: context, contextWindow: null, percent: null } } });
      contextTokens = context;
    }
    if (now.model !== null && now.model !== "" && now.model !== model) {
      events.push({ kind: "model", model: now.model });
      model = now.model;
    }
    if (events.length > 0) {
      kernel.frame({ type: "thread/usage", native: now.native, events });
    }
  };

  const record = (current: Turn, history: readonly CybionHistoryRecord[]): void => {
    for (const entry of history) {
      if (entry.id <= current.seen) {
        continue;
      }
      current.seen = entry.id;
      seen = Math.max(seen, entry.id);
      current.worked = true;
      current.quiet = 0;
      kernel.frame({ type: frameTypeOf(entry), native: entry.native, events: eventsOfHistory(entry) });
    }
  };

  const finish = (current: Turn, now: CybionThread | null, outcome: TurnOutcome): void => {
    const ending: RuntimeEventBody = { kind: "turn_ended", outcome };
    if (now === null) {
      kernel.frame({ type: "thread/lost", native: null, events: [ending] });
    } else {
      kernel.frame({ type: `thread/${now.displayStatus}`, native: now.native, events: [ending] });
    }
    turn = null;
    current.ended.resolve();
    options.onIdle();
  };

  const step = async (current: Turn): Promise<void> => {
    const now = await readThread(client, thread.id);
    record(current, await readHistory(client, thread.id));
    emitUsage(now);
    observe(current, now);
    if (!current.worked && current.startPolls >= START_POLLS) {
      finish(current, null, { kind: "failed", failure: "unknown", reason: "Cybion accepted the input but the Thread neither ran nor recorded it" });
      return;
    }
    if (current.worked && now.status !== "running" && current.quiet >= QUIET_POLLS) {
      finish(current, now, outcomeOf(now));
    }
  };

  const lose = (current: Turn): void => {
    // The deployment stopped answering: the stream says so once, and the turn
    // ends as a runtime exit. The Thread itself may still run there.
    if (kernel.unreachable() === null) {
      kernel.respond("", { kind: "exited", code: null });
    }
    options.onUnreachable?.();
    finish(current, null, { kind: "failed", failure: "runtime_exited", reason: "Cybion stopped answering; the Thread may still be running there" });
  };

  const pump = async (): Promise<void> => {
    pumping = true;
    let wait = POLL_FIRST_MS;
    let failures = 0;
    try {
      for (let first = true; ; first = false) {
        const current = turn;
        if (closed || current === null) {
          break;
        }
        if (!first) {
          await delay(wait);
          wait = Math.min(POLL_MAX_MS, Math.round(wait * 1.5));
        }
        try {
          await step(current);
          failures = 0;
        } catch {
          failures += 1;
          if (failures >= UNREACHABLE_AFTER) {
            lose(current);
          }
        }
      }
    } finally {
      pumping = false;
    }
  };

  return {
    busy: () => turn !== null,
    follow: (recordIdx) => {
      if (closed) {
        return;
      }
      const base = recordIdx === null ? seen : Math.max(seen, recordIdx - 1);
      const replaced = turn;
      turn = { ended: Promise.withResolvers<void>(), seen: base, worked: false, quiet: 0, startPolls: 0 };
      replaced?.ended.resolve();
      if (!pumping) {
        void pump();
      }
    },
    settle: async (ms) => {
      const current = turn;
      if (current === null) {
        return;
      }
      await Promise.race([current.ended.promise, delay(ms)]);
    },
    close: () => {
      closed = true;
      turn = null;
    },
  };
}
