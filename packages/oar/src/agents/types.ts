import type { Runtime } from "../contracts/runtime.js";
import type { ControlOutcome, Session, TaskEventBody, TurnOutcome, Unsubscribe } from "../contracts/session.js";
import type { TaskView } from "../observe/tasks.js";

export interface SubagentsOptions {
  /** Where `spawn` finds runtimes by id; the built-in registry by default. */
  readonly runtimes?: { get(id: string): Runtime | undefined };
  /** Subagents whose turn may run at once; a spawn or follow-up past it is refused. Default 4. */
  readonly maxRunning?: number;
  /**
   * How deep subagents may nest. This process's own depth is
   * `OAR_SUBAGENT_DEPTH` (0 when unset); its children run with depth + 1, so
   * a child that hosts subagents of its own refuses once the limit is reached.
   * Default 1: children do not spawn.
   */
  readonly maxDepth?: number;
  /** Working directory for children that name none; `process.cwd()` by default. */
  readonly cwd?: string;
  /** Write each child's records to `<logDir>/<id>.jsonl` as an oar-voyage log. */
  readonly logDir?: string;
  /** Environment overlaid on every child (each spawn may add its own). */
  readonly env?: Readonly<Record<string, string>>;
}

export interface SpawnOptions {
  readonly runtime: string;
  /** The first input: the task. */
  readonly task: string;
  /** A name the parent can use for it; the id is `name` when free, else derived. */
  readonly name?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly effort?: string;
  /** Resume this runtime-native session (a previous report's `sessionId`) instead of starting one. */
  readonly resume?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export type SpawnRefusalCode =
  | "unknown_runtime"
  | "not_installed"
  | "depth_limit"
  | "running_limit"
  | "open_failed"
  | "rejected";

export type SpawnResult =
  | { readonly kind: "spawned"; readonly agent: Subagent }
  | { readonly kind: "refused"; readonly code: SpawnRefusalCode; readonly reason: string };

/** `running` while a turn of the child's root agent is open; `closed` after `close`. */
export type SubagentState = "running" | "idle" | "closed";

/** One finished turn of a subagent: what its parent reads. */
export interface SubagentReport {
  readonly id: string;
  readonly name?: string;
  readonly runtime: string;
  /** The runtime-native session: pass it as `SpawnOptions.resume` to continue later. */
  readonly sessionId: string;
  /** 1 for the task, then one per later turn (a follow-up, a queued input, a turn the runtime began itself). */
  readonly turn: number;
  readonly outcome: TurnOutcome;
  /** What the child's root agent said in that turn, as the runtime said it. */
  readonly text: string;
  readonly log?: string;
  readonly endedAt: number;
}

export interface SubagentInfo {
  readonly id: string;
  readonly name?: string;
  readonly runtime: string;
  readonly sessionId: string;
  readonly state: SubagentState;
  /** Turns ended so far. */
  readonly turns: number;
  readonly log?: string;
}

/**
 * How a message reaches a child: `followup` starts a turn when the child is
 * idle and steers the running one otherwise (queueing when it cannot steer);
 * `steer` and `queue` are the session controls of the same names.
 */
export type SendMode = "followup" | "steer" | "queue";

export type SendResult =
  | { readonly kind: "accepted"; readonly landed: "prompted" | "steered" | "queued" }
  | { readonly kind: "rejected"; readonly code: string; readonly reason: string };

export interface Subagent {
  readonly id: string;
  readonly name?: string;
  readonly runtime: string;
  /** The child's own session, for everything the subagent surface does not cover. */
  readonly session: Session;
  info(): SubagentInfo;
  /** The report of the next turn to end: the open one while running, else the next one started. */
  nextReport(): Promise<SubagentReport>;
  send(message: string, mode?: SendMode): Promise<SendResult>;
  /** Interrupt the open turn; its report follows with the runtime's outcome. */
  interrupt(): Promise<ControlOutcome>;
  close(): Promise<void>;
}

/** A task event about a subagent, in the shape runtimes report their own tasks; `at` is when it happened. */
export type SubagentTaskEvent = TaskEventBody & { readonly at: number };

export interface WaitOptions {
  /** Only these subagents' reports; all by default. */
  readonly ids?: readonly string[];
  /** How long to wait when no report is unread; 0 returns at once. Default 30 s. */
  readonly timeoutMs?: number;
}

export interface DeliverOptions {
  readonly format?: (report: SubagentReport) => string;
}

export interface Subagents {
  spawn(options: SpawnOptions): Promise<SpawnResult>;
  get(id: string): Subagent | undefined;
  list(): readonly SubagentInfo[];
  /** Take the unread reports, waiting up to `timeoutMs` for one when none are unread. */
  wait(options?: WaitOptions): Promise<readonly SubagentReport[]>;
  /** The unread reports, without taking them. */
  unread(): readonly SubagentReport[];
  /** Task events for every subagent, live; `tasks()` folds them. */
  onTask(observer: (event: SubagentTaskEvent) => void): Unsubscribe;
  tasks(): readonly TaskView[];
  /**
   * Deliver every report into a parent session as input, taking it from the
   * unread ones: a prompt when the parent is idle (so it wakes), otherwise
   * steered into its turn or queued behind it.
   */
  deliverTo(parent: Session, options?: DeliverOptions): Unsubscribe;
  /** Close every subagent. */
  close(): Promise<void>;
}
