import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeEventBody, TurnOutcome } from "../../contracts/records.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import type { CybionClient } from "./client.js";
import { eventsOfHistory, frameTypeOf } from "./projection.js";
import { readHistory, readThread, type CybionHistoryRecord, type CybionThread, type CybionUsage } from "./thread.js";
import { observe, outcomeOf, sameUsage, totalsSince, type Turn } from "./tracker-facts.js";

/** First wait between polls of a running Thread. */
const POLL_FIRST_MS = 250;
/** The longest wait between polls: a turn that runs for minutes costs one read a second. */
const POLL_MAX_MS = 2000;
/** Quiet polls after the Thread stopped running, before its turn is read as ended. */
const QUIET_POLLS = 2;
/**
 * Polls an accepted input gets to make the Thread `running` before its turn is
 * read as never started. Cybion answers `POST /inputs` with the record the
 * input occupies, not with a settled `running` status: the Thread may sit
 * `idle` while it waits for a Worker, so the guard is generous.
 */
const START_POLLS = 60;
/** Consecutive failed reads after which one turn is given up as unreachable. */
const UNREACHABLE_AFTER = 8;

export interface ThreadTracker {
  /** A turn runs in the Thread, or one is being dispatched. */
  busy(): boolean;
  /** Follow the turn an accepted input started, whose own record is `recordIdx`. */
  follow(recordIdx: number | null): void;
  /**
   * Record an accepted steer, whose own record is `recordIdx`, into the turn
   * being followed. Cybion appends the input to the turn that runs, so that turn
   * keeps its identity and must not be replaced; it also cannot end until the
   * Thread is seen running or writing past the steer.
   */
  steer(recordIdx: number | null): void;
  /** The followed turn's identity, or null when none is followed. */
  turnId(): number | null;
  /**
   * Record that Cybion stopped the turn `id` because this session asked it to: only
   * then does `stopped` end that turn before it was seen running.
   */
  stoppedByUs(id: number): void;
  /** Resolves when the turn followed now has ended, or after `ms`. */
  settle(ms: number): Promise<void>;
  /** Stop following; nothing more is recorded. */
  close(): void;
}

export interface TrackerOptions {
  readonly client: CybionClient;
  readonly kernel: SessionKernel;
  readonly thread: CybionThread;
  /** The last history record this process already recorded, so a turn frames only what is new. */
  readonly seen: number;
  /** Called after a turn ended with the Thread idle and nothing given up. */
  readonly onIdle: () => void;
  /**
   * Called when a turn was given up as unreachable. Nothing will poll again on
   * its own, so input held for a later turn has to be handed back rather than
   * left waiting behind a turn that ended.
   */
  readonly onGivenUp?: () => void;
  /**
   * How the next poll is spaced. The default is a real timer that does not hold
   * the host process open; a test passes its own so a poll happens when the
   * test says so.
   */
  readonly wait?: (ms: number) => Promise<void>;
}

/** What one poll of the Thread says about the turn: running, quiet, or not yet started. */
/**
 * One OAR session is one Cybion Thread, followed through the Agent API
 * (`GET /v1/threads/{id}` and `/history`; docs/runtimes/cybion.md). Cybion's
 * surface streams nothing, so a turn is followed by polling:
 *
 * - Every history record past the ones this process already recorded becomes
 *   one frame carrying the record verbatim and the events read out of it
 *   (projection.ts). The cursor only ever moves forward, so a record written
 *   between two turns is framed by the next turn's polls rather than skipped,
 *   and nothing is framed twice.
 * - The Thread's own status says when the turn ended: `running` while it
 *   works, then a refined idle word (`completed`, `stopped`, `blocked`). The
 *   end is read only after two quiet polls, so a status write that lands a
 *   moment after the last record is not mistaken for a finished turn.
 * - A turn counts as work only once the Thread reports `running` or writes a
 *   record after the input. The input's own record does not count: an idle
 *   status left over from the previous turn would otherwise end this one
 *   before it began.
 * - Token totals are Cybion's own Thread totals, reported as the session's
 *   running total (what the Thread spent, less what it carried when the
 *   session opened), so no turn is counted twice.
 * - A deployment that stops answering ends the turn as a failed one and
 *   leaves the session usable: nothing here claims a process exited, because
 *   the Thread keeps existing on Cybion's side.
 */
export function createThreadTracker(options: TrackerOptions): ThreadTracker {
  const { client, kernel, thread } = options;
  const opened = thread.usage;
  const wait: (ms: number) => Promise<void> = options.wait ?? (async (ms) => {
    await delay(ms, undefined, { ref: false });
  });
  let turn: Turn | null = null;
  let closed = false;
  let turns = 0;
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
      if (entry.id <= seen) {
        continue;
      }
      seen = entry.id;
      if (current.steerRecord !== null && entry.id > current.steerRecord) {
        current.steerRecord = null;
      }
      if (entry.id > current.after) {
        current.worked = true;
        current.quiet = 0;
      }
      kernel.frame({ type: frameTypeOf(entry), native: entry.native, events: eventsOfHistory(entry) });
    }
  };

  /** This turn is no longer the one being followed, or the session was released. */
  const abandoned = (current: Turn): boolean => closed || turn !== current;

  const finish = (current: Turn, now: CybionThread | null, outcome: TurnOutcome, idle: boolean): void => {
    const ending: RuntimeEventBody = { kind: "turn_ended", outcome };
    if (now === null) {
      kernel.frame({ type: "thread/lost", native: null, events: [ending] });
    } else {
      kernel.frame({ type: `thread/${now.displayStatus}`, native: now.native, events: [ending] });
    }
    turn = null;
    current.ended.resolve();
    if (idle && !closed) {
      options.onIdle();
    }
  };

  const step = async (current: Turn): Promise<void> => {
    const now = await readThread(client, thread.id);
    if (abandoned(current)) {
      return;
    }
    const history = await readHistory(client, thread.id);
    if (abandoned(current)) {
      // A release that landed while the read was in flight frames nothing.
      return;
    }
    record(current, history);
    emitUsage(now);
    observe(current, now);
    if (now.displayStatus === "stopped" && (current.worked || current.stoppedByUs)) {
      // A turn this Thread stopped, or one this session stopped for it, ends here
      // even if it was never seen running; a `stopped` carried over from an earlier
      // turn is not this turn's end and falls through to the start guard.
      finish(current, now, { kind: "aborted" }, true);
      return;
    }
    if (!current.worked && current.startPolls >= START_POLLS) {
      finish(current, null, { kind: "failed", failure: "unknown", reason: "Cybion recorded the input but the Thread never ran a turn" }, true);
      return;
    }
    if (current.worked && now.status !== "running" && current.quiet >= QUIET_POLLS) {
      if (current.steerRecord !== null) {
        // A steer is waiting to be taken in. Cybion may not have picked it up
        // yet, so an idle read here says nothing about the turn this input will
        // run in. Give up only once the wait has grown as long as a start.
        if (current.quiet >= START_POLLS) {
          finish(current, now, { kind: "failed", failure: "unknown", reason: "Cybion accepted a steered input but the Thread never ran it" }, true);
        }
        return;
      }
      finish(current, now, outcomeOf(now), true);
    }
  };

  const pump = async (): Promise<void> => {
    pumping = true;
    let backoff = POLL_FIRST_MS;
    let failures = 0;
    try {
      for (let first = true; ; first = false) {
        const current = turn;
        if (closed || current === null) {
          break;
        }
        if (!first) {
          await wait(backoff);
          backoff = Math.min(POLL_MAX_MS, Math.round(backoff * 1.5));
        }
        try {
          await step(current);
          failures = 0;
        } catch {
          failures += 1;
          if (failures >= UNREACHABLE_AFTER && turn === current) {
            // The deployment stopped answering. Nothing exited — the Thread still
            // runs on Cybion's side — so the turn fails and the session stays
            // usable, and a held input waits rather than starting a turn nobody
            // is watching.
            finish(current, null, { kind: "failed", failure: "unknown", reason: "Cybion stopped answering; the Thread may still be running there" }, false);
            options.onGivenUp?.();
          }
        }
      }
    } finally {
      pumping = false;
    }
  };

  const followTurn = (recordIdx: number | null): void => {
    if (closed) {
      return;
    }
    const replaced = turn;
    turns += 1;
    turn = {
      id: turns,
      ended: Promise.withResolvers<void>(),
      after: recordIdx ?? seen,
      worked: false,
      quiet: 0,
      startPolls: 0,
      stoppedByUs: false,
      steerRecord: null,
    };
    replaced?.ended.resolve();
    if (!pumping) {
      void pump();
    }
  };

  return {
    busy: () => turn !== null,
    follow: followTurn,
    turnId: () => turn?.id ?? null,
    stoppedByUs: (id) => {
      if (turn?.id === id) {
        turn.stoppedByUs = true;
      }
    },
    steer: (recordIdx) => {
      const current = turn;
      if (current === null) {
        // Nothing is followed, so there is no turn for the input to continue; the
        // session decides what it became instead of following one here.
        return;
      }
      // Records past the steer are this turn's own work too, and the turn keeps
      // its identity: the same `ended` promise, the same cursor, one `turn_ended`.
      // Its quiet count restarts, and it cannot end until the Thread is seen
      // running or writing past the input.
      current.after = Math.max(current.after, recordIdx ?? current.after);
      current.steerRecord = Math.max(current.steerRecord ?? Number.NEGATIVE_INFINITY, recordIdx ?? seen);
      current.quiet = 0;
    },
    settle: async (ms) => {
      const current = turn;
      if (current === null) {
        return;
      }
      await Promise.race([current.ended.promise, wait(ms)]);
    },
    close: () => {
      closed = true;
      turn = null;
    },
  };
}
