import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeEventBody } from "../../contracts/session.js";
import { asRecord } from "../../shared/json.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import type { ConsoleClient } from "./console.js";
import {
  TERMINAL_TASK_STATUSES,
  foldMorphStream,
  foldMorphTask,
  initialMorphProjection,
  morphContextEvents,
  type MorphProjection,
} from "./projection.js";

const POLL_FIRST_MS = 250;
const POLL_MAX_MS = 1000;
/** Consecutive failed task queries after which an attached Console is taken for gone. */
const UNREACHABLE_AFTER = 8;

interface Tracked {
  readonly taskId: string;
  status: string | null;
  reportedRunning: boolean;
  readonly approved: Set<string>;
  closeStream: () => void;
  readonly ended: PromiseWithResolvers<void>;
}

export interface TaskTracker {
  /** A task runs in the topic, or one waits behind it. */
  busy(): boolean;
  /** The task whose turn runs now. */
  active(): string | null;
  /** Follow a task until it ends: its snapshots and status changes become frames, its end the turn's. */
  follow(taskId: string): void;
  /** Resolves when every task followed now has ended, or after `ms`. */
  settle(ms: number): Promise<void>;
  /** Stop following everything; nothing more is recorded. */
  close(): void;
}

export interface TrackerOptions {
  readonly client: ConsoleClient;
  readonly kernel: SessionKernel;
  readonly topicId: string;
  /** Called after a turn ended with nothing left running. */
  readonly onIdle: () => void;
  /** Called when the Console stops answering: an attached one this adapter cannot watch otherwise. */
  readonly onUnreachable: (() => void) | null;
}

/**
 * Each followed task: `/stream/ws` snapshots are frames as they arrive (the
 * socket reconnects while the task runs); `GET /tasks/{id}` answers are
 * frames when they report a new status; the terminal one is read with the
 * topic's context fullness just before it and ends the turn. A task pending
 * on an approval is approved (sessions run YOLO) as a toApp request and its
 * answer.
 */
export function createTaskTracker(options: TrackerOptions): TaskTracker {
  const { client, kernel, topicId } = options;
  const tracked: Tracked[] = [];
  let projection: MorphProjection = initialMorphProjection;
  let closed = false;

  // A newer task may already be running while the previous task's terminal poll is pending.
  const runningEvents = (task: Tracked, id: unknown, status: unknown): readonly RuntimeEventBody[] => {
    if (task !== tracked[0] || id !== task.taskId || status !== "running" || task.reportedRunning) { return []; }
    task.reportedRunning = true;
    return [{ kind: "turn_active" }];
  };

  const recordStream = (task: Tracked, frame: unknown): void => {
    const fold = foldMorphStream(projection, frame);
    projection = fold.state;
    const snapshot = asRecord(frame);
    const status = snapshot?.status;
    const events = [...runningEvents(task, snapshot?.task_id, status), ...fold.events];
    kernel.frame({ type: `stream/${typeof status === "string" ? status : "snapshot"}`, native: frame, events });
  };

  const approve = async (task: Tracked, approvalId: string): Promise<void> => {
    task.approved.add(approvalId);
    const info = await client.call("GET", `/approvals/${encodeURIComponent(approvalId)}`);
    kernel.request("toApp", { kind: "native", type: "approval", native: info.body }, { id: approvalId });
    const decision = await client.call("POST", `/approvals/${encodeURIComponent(approvalId)}/approve`, { actor: "oar", note: "OAR sessions run without approval gates" });
    kernel.respond(approvalId, { kind: "answered", native: decision.body });
  };

  const finish = async (task: Tracked, info: unknown): Promise<void> => {
    try {
      const metadata = await client.call("GET", `/topic/${encodeURIComponent(topicId)}/metadata`);
      if (metadata.status === 200) {
        kernel.frame({ type: "topic/metadata", native: metadata.body, events: morphContextEvents(metadata.body) });
      }
    } catch {
      // Context fullness is optional; the turn still ends.
    }
    const fold = foldMorphTask(projection, info);
    projection = fold.state;
    kernel.frame({ type: `task/${task.status ?? "unknown"}`, native: info, events: fold.events });
    task.closeStream();
    tracked.splice(tracked.indexOf(task), 1);
    task.ended.resolve();
    if (tracked.length === 0) {
      options.onIdle();
    }
  };

  /** One task query; true once the task has ended. */
  const check = async (task: Tracked): Promise<boolean> => {
    const reply = await client.call("GET", `/tasks/${encodeURIComponent(task.taskId)}`);
    const info = asRecord(reply.body);
    const status = typeof info?.status === "string" ? info.status : null;
    if (reply.status !== 200 || status === null) {
      return false;
    }
    const events = runningEvents(task, info?.id, status);
    if (status !== task.status || events.length > 0) {
      task.status = status;
      if (TERMINAL_TASK_STATUSES.has(status)) {
        await finish(task, reply.body);
        return true;
      }
      kernel.frame({ type: `task/${status}`, native: reply.body, events });
    }
    const approvalId = info?.approval_request_id;
    if (status === "pending" && typeof approvalId === "string" && approvalId !== "" && !task.approved.has(approvalId)) {
      try {
        await approve(task, approvalId);
      } catch {
        // An approval that cannot be answered leaves the task pending; abort still works.
      }
    }
    return false;
  };

  const poll = async (task: Tracked): Promise<void> => {
    let wait = POLL_FIRST_MS;
    let failures = 0;
    const following = (): boolean => !closed && tracked.includes(task);
    while (following()) {
      // oxlint-disable-next-line no-await-in-loop -- one query at a time, paced by the backoff.
      await delay(wait);
      if (!following()) {
        return;
      }
      const status = task.status;
      try {
        // oxlint-disable-next-line no-await-in-loop -- the next query depends on this answer.
        if (await check(task)) {
          return;
        }
        failures = 0;
      } catch {
        failures += 1;
        if (failures >= UNREACHABLE_AFTER && options.onUnreachable !== null) {
          options.onUnreachable();
          return;
        }
      }
      wait = task.status === status ? Math.min(POLL_MAX_MS, wait * 2) : POLL_FIRST_MS;
    }
  };

  return {
    busy: () => tracked.length > 0,
    active: () => tracked[0]?.taskId ?? null,
    follow(taskId) {
      if (closed || tracked.some((task) => task.taskId === taskId)) {
        return;
      }
      let streaming = true;
      const task: Tracked = {
        taskId,
        status: null,
        reportedRunning: false,
        approved: new Set(),
        closeStream: () => {
          streaming = false;
        },
        ended: Promise.withResolvers(),
      };
      const connect = (): void => {
        const close = client.stream(taskId, frame => { recordStream(task, frame); }, (): void => {
          // Snapshots are a live view: reconnect while the task runs; the
          // task query settles the turn even if the stream stays away.
          if (streaming && !closed && tracked.includes(task)) {
            setTimeout(connect, POLL_MAX_MS).unref();
          }
        });
        task.closeStream = (): void => {
          streaming = false;
          close();
        };
      };
      tracked.push(task);
      connect();
      void poll(task);
    },
    async settle(ms) {
      await Promise.race([Promise.all(tracked.map(async (task) => {
        await task.ended.promise;
      })), delay(ms, undefined, { ref: false })]);
    },
    close() {
      closed = true;
      for (const task of tracked.splice(0)) {
        task.closeStream();
        task.ended.resolve();
      }
    },
  };
}
