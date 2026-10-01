import type { ControlOutcome, Event, Session, TaskEventBody, TurnOutcome } from "../contracts/session.js";
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

/**
 * One child session as a subagent: every turn its root agent ends becomes a
 * report carrying the root text said in that turn, whether the turn began
 * from the task, a follow-up, a queued input or the runtime itself.
 */
export function createSubagent(identity: SubagentIdentity, session: Session, hooks: SubagentHooks): Subagent {
  let state: SubagentState = "idle";
  let turns = 0;
  let text = "";
  let waiters: ((report: SubagentReport) => void)[] = [];

  const isRoot = (event: Event): boolean => event.sessionId === session.id && event.agentPath.length === 0;

  const ended = (outcome: TurnOutcome, at: number): void => {
    turns += 1;
    state = state === "closed" ? "closed" : "idle";
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
    hooks.task({
      kind: "task_ended",
      taskId: identity.id,
      status: endStatus(outcome),
      ...(report.text === "" ? {} : { summary: report.text.slice(0, 200) }),
      ...(identity.log === undefined ? {} : { outputFile: identity.log }),
    });
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) {
      waiter(report);
    }
    hooks.report(report);
  };

  const observe = (event: Event): void => {
    if (!isRoot(event)) {
      return;
    }
    if (event.kind === "turn_ended") {
      ended(event.outcome, event.receivedAt);
      return;
    }
    if (event.kind === "exited") {
      // A runtime that died mid-turn reported no end of its own; the parent still gets one.
      if (state === "running") {
        ended({ kind: "failed", reason: `the runtime exited (${String(event.code)})`, failure: "runtime_exited" }, event.receivedAt);
      }
      state = "closed";
      return;
    }
    if (state === "idle" && session.status().value.kind === "running") {
      state = "running";
      hooks.task({ kind: "task_updated", taskId: identity.id, status: "running" });
    }
    if (event.kind === "text_delta") {
      text += event.text;
    }
  };
  session.events(observe);

  const followup = async (message: string): Promise<SendResult> => {
    if (session.status().value.kind === "idle") {
      if (!hooks.mayRun()) {
        return { kind: "rejected", code: "running_limit", reason: "the running limit is reached; wait for a subagent to finish" };
      }
      const outcome = await session.prompt(message);
      return outcome.kind === "accepted" ? { kind: "accepted", landed: "prompted" } : rejected(outcome);
    }
    const result = await session.steerOrQueue(message);
    return result.landed === "rejected"
      ? { kind: "rejected", code: result.code, reason: result.reason }
      : { kind: "accepted", landed: result.landed };
  };

  const agent: Subagent = {
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
    nextReport: async (): Promise<SubagentReport> => {
      const report = await new Promise<SubagentReport>((resolve) => {
        waiters.push(resolve);
      });
      return report;
    },
    send: async (message: string, mode: SendMode = "followup"): Promise<SendResult> => {
      if (state === "closed") {
        return { kind: "rejected", code: "closed", reason: `${identity.id} is closed` };
      }
      if (mode === "followup") {
        const result = await followup(message);
        return result;
      }
      const outcome = mode === "steer" ? await session.steer(message) : await session.queue(message);
      return outcome.kind === "accepted" ? { kind: "accepted", landed: mode === "steer" ? "steered" : "queued" } : rejected(outcome);
    },
    interrupt: async (): Promise<ControlOutcome> => {
      const outcome = await session.abort();
      return outcome;
    },
    close: async (): Promise<void> => {
      if (state === "closed") {
        return;
      }
      const open = state === "running" ? turns : null;
      state = "closed";
      await session.dispose();
      if (open !== null && turns === open) {
        // Disposed mid-turn and the runtime reported no end for it.
        hooks.task({ kind: "task_ended", taskId: identity.id, status: "stopped" });
      }
      hooks.closed();
    },
  };
  return agent;
}
