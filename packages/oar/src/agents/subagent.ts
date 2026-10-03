import type { ControlOutcome, Event, Session, TaskEventBody, TaskStatus, TurnOutcome } from "../contracts/session.js";
import type { SendMode, SendResult, Subagent, SubagentInfo, SubagentReport, SubagentState } from "./types.js";

/** What a subagent tells the crew that owns it. */
export interface SubagentHooks {
  readonly report: (report: SubagentReport) => void;
  readonly task: (event: TaskEventBody) => void;
  /** Whether one more turn may start now (the crew's running limit). */
  readonly mayRun: () => boolean;
  readonly closed: () => void;
}

export interface SubagentIdentity {
  readonly id: string;
  readonly name?: string;
  readonly runtime: string;
  readonly log?: string;
}

const RUNNING_LIMIT: SendResult = { kind: "rejected", code: "running_limit", reason: "the running limit is reached; wait for a subagent to finish" };

function endStatus(outcome: TurnOutcome): "completed" | "failed" | "stopped" {
  if (outcome.kind === "completed") {
    return "completed";
  }
  return outcome.kind === "aborted" ? "stopped" : "failed";
}

function rejected(outcome: ControlOutcome): SendResult {
  return outcome.kind === "accepted"
    ? { kind: "rejected", code: "unknown", reason: "accepted" }
    : { kind: "rejected", code: outcome.code, reason: outcome.reason };
}

async function steerOrQueue(session: Session, message: string): Promise<SendResult> {
  const result = await session.steerOrQueue(message);
  return result.landed === "rejected"
    ? { kind: "rejected", code: result.code, reason: result.reason }
    : { kind: "accepted", landed: result.landed };
}

/**
 * One child session as a subagent: every turn its root agent ends becomes a
 * report carrying the root text said in that turn, whether the turn began
 * from the task, a follow-up, a queued input or the runtime itself. A turn
 * the runtime never ends (its process exited, or `close` disposed it) still
 * gets a report, so nobody waits on it forever.
 */
export function createSubagent(identity: SubagentIdentity, session: Session, hooks: SubagentHooks): Subagent {
  let state: SubagentState = "idle";
  let closing = false;
  let turns = 0;
  let text = "";
  let lastEnd: TaskStatus | null = null;
  let waiters: ((report: SubagentReport | null) => void)[] = [];

  const settle = (report: SubagentReport | null): void => {
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) {
      waiter(report);
    }
  };

  const ended = (outcome: TurnOutcome, at: number): void => {
    turns += 1;
    if (state === "running") {
      state = "idle";
    }
    const report: SubagentReport = {
      id: identity.id,
      ...(identity.name === undefined ? {} : { name: identity.name }),
      runtime: identity.runtime,
      sessionId: session.id,
      turn: turns,
      outcome,
      text,
      ...(identity.log === undefined ? {} : { log: identity.log }),
      endedAt: at,
    };
    text = "";
    lastEnd = endStatus(outcome);
    settle(report);
    hooks.report(report);
    hooks.task({
      kind: "task_ended",
      taskId: identity.id,
      status: lastEnd,
      ...(report.text === "" ? {} : { summary: report.text.slice(0, 200) }),
      ...(identity.log === undefined ? {} : { outputFile: identity.log }),
    });
  };

  const shut = (): void => {
    state = "closed";
    settle(null);
    hooks.closed();
  };

  const exited = (code: number | null, at: number): void => {
    if (closing) {
      return;
    }
    // A runtime that died mid-turn reported no end of its own; the parent still gets one.
    if (state === "running") {
      ended({ kind: "failed", reason: `the runtime exited (${String(code)})`, failure: "runtime_exited" }, at);
    }
    shut();
  };

  const observe = (event: Event): void => {
    if (event.sessionId !== session.id || event.agentPath.length > 0) {
      return;
    }
    if (event.kind === "turn_ended") {
      ended(event.outcome, event.receivedAt);
    } else if (event.kind === "exited") {
      exited(event.code, event.receivedAt);
    } else if (event.kind === "control_rejected") {
      // A refused start leaves no turn open; the slot and the task row go back.
      if (state === "running" && session.status().value.kind === "idle") {
        state = "idle";
        hooks.task({ kind: "task_updated", taskId: identity.id, status: lastEnd ?? "pending" });
      }
    } else {
      if (state === "idle" && !closing && session.status().value.kind === "running") {
        state = "running";
        hooks.task({ kind: "task_updated", taskId: identity.id, status: "running" });
      }
      if (event.kind === "text_delta") {
        text += event.text;
      }
    }
  };
  session.events(observe);

  const followup = async (message: string): Promise<SendResult> => {
    if (session.status().value.kind !== "idle") {
      const steered = await steerOrQueue(session, message);
      return steered;
    }
    if (!hooks.mayRun()) {
      return RUNNING_LIMIT;
    }
    const outcome = await session.prompt(message);
    if (outcome.kind === "accepted") {
      return { kind: "accepted", landed: "prompted" };
    }
    // A turn the runtime began by itself can open between the status read and the prompt.
    if (outcome.code === "busy") {
      const steered = await steerOrQueue(session, message);
      return steered;
    }
    return rejected(outcome);
  };

  const control = async (message: string, mode: "steer" | "queue"): Promise<SendResult> => {
    if (mode === "steer") {
      // A session that cannot steer has no `steer`; nothing reaches the runtime.
      if (session.steer === undefined) {
        return { kind: "rejected", code: "unsupported", reason: `${identity.runtime} cannot steer; send followup or queue instead` };
      }
      const steered = await session.steer(message);
      return steered.kind === "accepted" ? { kind: "accepted", landed: "steered" } : rejected(steered);
    }
    if (session.status().value.kind === "idle" && !hooks.mayRun()) {
      return RUNNING_LIMIT;
    }
    const queued = await session.queue(message);
    return queued.kind === "accepted" ? { kind: "accepted", landed: "queued" } : rejected(queued);
  };

  return {
    id: identity.id,
    ...(identity.name === undefined ? {} : { name: identity.name }),
    runtime: identity.runtime,
    session,
    info: (): SubagentInfo => ({
      id: identity.id,
      ...(identity.name === undefined ? {} : { name: identity.name }),
      runtime: identity.runtime,
      sessionId: session.id,
      state,
      turns,
      ...(identity.log === undefined ? {} : { log: identity.log }),
    }),
    nextReport: async (): Promise<SubagentReport | null> => {
      if (state === "closed") {
        return null;
      }
      const { promise, resolve } = Promise.withResolvers<SubagentReport | null>();
      waiters.push(resolve);
      const report = await promise;
      return report;
    },
    send: async (message: string, mode: SendMode = "followup"): Promise<SendResult> => {
      if (state === "closed" || closing) {
        return { kind: "rejected", code: "closed", reason: `${identity.id} is closed` };
      }
      const result = mode === "followup" ? await followup(message) : await control(message, mode);
      return result;
    },
    interrupt: async (): Promise<ControlOutcome> => {
      const outcome = await session.abort();
      return outcome;
    },
    close: async (): Promise<void> => {
      if (state === "closed" || closing) {
        return;
      }
      closing = true;
      const open = state === "running" ? turns : null;
      await session.dispose();
      if (open !== null && turns === open) {
        // Disposed mid-turn and the runtime reported no end for it.
        ended({ kind: "aborted" }, Date.now());
      }
      shut();
    },
  };
}
