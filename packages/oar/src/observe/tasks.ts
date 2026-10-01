import type { QueryResult, RawEvent, TaskEventBody, TaskStatus, TaskType } from "../contracts/session.js";

/**
 * One task as its runtime reported it, for a task panel: the shape a host
 * draws for background commands and subagents alike. `sessionId` and
 * `agentPath` say whose task it is (a subagent can start tasks of its own);
 * `startedAt` / `endedAt` are the `receivedAt` of the reports.
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

function apply(previous: TaskView | undefined, event: TaskEvent): TaskView {
  switch (event.kind) {
    case "task_started": {
      const { kind: _kind, receivedAt, ...fields } = event;
      return { ...previous, ...fields, status: previous?.status ?? "running", startedAt: receivedAt };
    }
    case "task_updated": {
      const { kind: _kind, receivedAt: _receivedAt, taskId: _taskId, sessionId: _sessionId, agentPath: _agentPath, ...patch } = event;
      return { ...(previous ?? placeholder(event)), ...patch };
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
 * again. Records without task events return the same map.
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

/** Every task the records report, with the seq of the last record read. */
export function tasksOf(records: readonly RawEvent[]): QueryResult<readonly TaskView[]> {
  let tasks = initialTasks;
  let seq = -1;
  for (const record of records) {
    tasks = reduceTasks(tasks, record);
    seq = record.seq;
  }
  return { value: [...tasks.values()], seq };
}
