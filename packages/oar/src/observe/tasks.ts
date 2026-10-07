import type { AgentStatus, QueryResult, RawEvent, TaskEventBody, TaskStatus, TaskType } from "../contracts/session.js";

import { initialStatus, reduceStatus } from "./agent-status.js";

/**
 * One task as its runtime reported it, for a task panel: the shape a host
 * draws for background commands and subagents alike. `sessionId` and
 * `agentPath` say whose task it is (a subagent can start tasks of its own);
 * `startedAt` / `endedAt` are the `receivedAt` of the reports. A root runtime
 * exit also ends unfinished tasks; its `receivedAt` supplies that ending.
 */
export interface TaskView {
  readonly taskId: string;
  readonly sessionId: string;
  readonly agentPath: readonly string[];
  readonly taskType: TaskType;
  readonly nativeType?: string;
  readonly description?: string;
  readonly status: TaskStatus;
  readonly background?: boolean;
  readonly ambient?: boolean;
  readonly toolCallId?: string;
  readonly childSessionId?: string;
  readonly summary?: string;
  readonly outputFile?: string;
  readonly error?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

/** Tasks by id, in the order the stream first named them. */
export type TaskMap = ReadonlyMap<string, TaskView>;

export const initialTasks: TaskMap = new Map();

type TaskEvent = TaskEventBody & { readonly sessionId: string; readonly agentPath: readonly string[]; readonly receivedAt: number };

function placeholder(event: TaskEvent): TaskView {
  // A report about a task whose start the stream does not hold (a mid-session
  // subscriber, a runtime that reported no start): still a fact worth a row.
  return { taskId: event.taskId, sessionId: event.sessionId, agentPath: event.agentPath, taskType: "other", status: "running" };
}

/** The row without what its last end said: a task running again has no end yet. */
function reopened(view: TaskView): TaskView {
  const { endedAt: _endedAt, summary: _summary, outputFile: _outputFile, ...open } = view;
  return open;
}

function apply(previous: TaskView | undefined, event: TaskEvent): TaskView {
  switch (event.kind) {
    case "task_started": {
      const { kind: _kind, receivedAt, ...fields } = event;
      // A start after an earlier start is the task beginning again (claude re-registers a resumed
      // subagent); a row made from reports that came before the start keeps what they said.
      const early = previous !== undefined && previous.startedAt === undefined;
      return early ? { ...previous, ...fields, startedAt: receivedAt } : { ...fields, status: "running", startedAt: receivedAt };
    }
    case "task_updated": {
      const { kind: _kind, receivedAt: _receivedAt, taskId: _taskId, sessionId: _sessionId, agentPath: _agentPath, ...patch } = event;
      const base = previous ?? placeholder(event);
      const again = patch.status === "pending" || patch.status === "running" || patch.status === "paused";
      return { ...(again ? reopened(base) : base), ...patch };
    }
    case "task_ended": {
      const { kind: _kind, receivedAt, taskId: _taskId, sessionId: _sessionId, agentPath: _agentPath, ...fields } = event;
      return { ...(previous ?? placeholder(event)), ...fields, endedAt: receivedAt };
    }
  }
  return previous ?? placeholder(event);
}

/** Where a task event was read: the record's session, agent and arrival time. */
export interface TaskEventOrigin {
  readonly sessionId: string;
  readonly agentPath: readonly string[];
  readonly receivedAt: number;
}

/** Fold one task event into the task map. Status follows the latest report. */
export function applyTaskEvent(previous: TaskMap, body: TaskEventBody, origin: TaskEventOrigin): TaskMap {
  const next = new Map(previous);
  const event: TaskEvent = { ...body, sessionId: origin.sessionId, agentPath: origin.agentPath, receivedAt: origin.receivedAt };
  next.set(body.taskId, apply(next.get(body.taskId), event));
  return next;
}

/**
 * Fold one record into the task map. Status follows the latest report: a
 * codex subagent that completed and is then given more work reads as running
 * again. Records without task events return the same map. This event-only
 * reducer does not infer endings at runtime exit; use `reduceTaskState` for that.
 */
export function reduceTasks(previous: TaskMap, record: RawEvent): TaskMap {
  if (record.kind !== "frame") {
    return previous;
  }
  let next = previous;
  for (const body of record.body.events) {
    if (body.kind === "task_started" || body.kind === "task_updated" || body.kind === "task_ended") {
      next = applyTaskEvent(next, body, record);
    }
  }
  return next;
}

/** Checkpointable task fold for one runtime process, including its child sessions. */
export interface TaskState {
  readonly tasks: TaskMap;
  readonly rootSessionId: string | undefined;
  /** Reuses the status fold's current-turn stop evidence. */
  readonly status: AgentStatus;
  /** A root dispose request also applies when no turn is running. */
  readonly disposed: boolean;
  /** Task ids whose current error was inferred from runtime exit, not reported natively. */
  readonly exitErrors: ReadonlySet<string>;
}

/** Start a fresh fold per runtime start/resume. Without an id, the first record selects the root. */
export function initialTaskState(rootSessionId?: string): TaskState {
  return { tasks: initialTasks, rootSessionId, status: initialStatus, disposed: false, exitErrors: new Set() };
}

function clearExitError(previous: TaskState, body: TaskEventBody): TaskState {
  const row = previous.tasks.get(body.taskId);
  if (!previous.exitErrors.has(body.taskId) || row === undefined
    || (body.kind === "task_updated" && body.status === undefined && body.error === undefined)) {
    return previous;
  }
  const { error: _error, ...reported } = row;
  const tasks = new Map<string, TaskView>([...previous.tasks, [body.taskId, reported]]);
  const exitErrors = new Set(previous.exitErrors);
  exitErrors.delete(body.taskId);
  return { ...previous, tasks, exitErrors };
}

function reduceTaskReports(previous: TaskState, record: RawEvent): TaskState {
  if (record.kind !== "frame") { return previous; }
  let next = previous;
  for (const body of record.body.events) {
    if (body.kind === "task_started" || body.kind === "task_updated" || body.kind === "task_ended") {
      next = clearExitError(next, body);
      next = { ...next, tasks: applyTaskEvent(next.tasks, body, record) };
    }
  }
  return next;
}

function endRuntimeTasks(previous: TaskState, receivedAt: number, stopped: boolean): TaskState {
  const tasks = new Map(previous.tasks);
  const exitErrors = new Set(previous.exitErrors);
  for (const [id, task] of tasks) {
    if (task.status !== "pending" && task.status !== "running" && task.status !== "paused") { continue; }
    const inferError = !stopped && task.error === undefined;
    tasks.set(id, { ...task, status: stopped ? "stopped" : "failed", endedAt: receivedAt,
      ...(inferError ? { error: "runtime exited" } : {}) });
    if (inferError) { exitErrors.add(id); }
  }
  return { ...previous, tasks, exitErrors };
}

/**
 * Fold task reports and root process exit. Pending/running/paused tasks, including
 * child tasks, end as stopped after dispose or an exit-aborted turn, failed otherwise.
 * Native endings remain authoritative, including reports arriving after exit.
 * Persist the whole state (including Maps/Sets), not just its task rows, to resume a fold.
 */
export function reduceTaskState(previous: TaskState, record: RawEvent): TaskState {
  const rootSessionId = previous.rootSessionId ?? record.sessionId;
  const root = record.sessionId === rootSessionId && record.agentPath.length === 0;
  const status = reduceStatus(previous.status, record, rootSessionId);
  const disposed = previous.disposed || (root && record.kind === "request" && record.direction === "toRuntime" && record.body.kind === "dispose");
  const next = { ...previous, rootSessionId, status, disposed };
  if (root && record.kind === "response" && record.body.kind === "exited") {
    const aborted = previous.status.kind === "running" && status.kind === "idle" && status.lastTurnOutcome?.kind === "aborted";
    return endRuntimeTasks(next, record.receivedAt, disposed || aborted);
  }
  return reduceTaskReports(next, record);
}

/**
 * Tasks in one runtime stream, including inferred endings at root process exit,
 * with the seq of the last record read. Pass the root id when the first record is a child's.
 */
export function tasksOf(records: readonly RawEvent[], rootSessionId?: string): QueryResult<readonly TaskView[]> {
  let state = initialTaskState(rootSessionId);
  let seq = -1;
  for (const record of records) {
    state = reduceTaskState(state, record);
    seq = record.seq;
  }
  return { value: [...state.tasks.values()], seq };
}
