import {
  classifyTool,
  toolActionLabel,
  type Event,
  type ToolActionKind,
  type TurnOutcome,
} from "@botiverse/oar";

// Pure rendering of session events into human-readable progress lines.
// Assistant text prints verbatim; everything else prints as a bracketed
// meta line so the two are distinguishable at a glance. Subscribe with
// `coalesceText` so text arrives in whole blocks.

interface StartedCall {
  readonly tool: string;
  readonly kind: ToolActionKind;
  /** The detail last printed for the call, so a later input prints only what is new. */
  readonly detail: string | undefined;
  readonly receivedAt: number;
}

/** What the session reported once it opened: its id (to pass back as `--resume`) and the model and effort folds, the runtime's word (null: not said yet). */
export interface OpenedSession {
  readonly sessionId: string;
  readonly resumed: boolean;
  readonly model: string | null;
  readonly effort: string | null;
}

/** The first progress line: which session this run is, and what model and effort the runtime says it runs, when it said so at open. */
export function renderOpened(opened: OpenedSession): string {
  const parts = [`${opened.resumed ? "resumed" : "session"} ${opened.sessionId}`];
  if (opened.model !== null) {
    parts.push(`model ${opened.model}`);
  }
  if (opened.effort !== null) {
    parts.push(`effort ${opened.effort}`);
  }
  return `[${parts.join(" · ")}]`;
}

export function renderOutcome(outcome: TurnOutcome): string {
  if (outcome.kind === "completed") {
    return "[turn completed]";
  }
  if (outcome.kind === "aborted") {
    return "[turn aborted]";
  }
  return `[turn failed: ${outcome.failure}] ${outcome.reason}`;
}

// Returns the printable line for one event, if any: turn starts, usage,
// model and effort reports, redacted/empty reasoning and empty text print
// nothing.
export function createProgressRenderer(
  runtimeId: string,
): (event: Event) => readonly string[] {
  const started = new Map<string, StartedCall>();
  return (event) => {
    const agent = event.agentPath.length === 0 ? "" : `[${event.agentPath.join("/")}] `;
    switch (event.kind) {
      case "text_delta":
        return event.text === "" ? [] : [`${agent}${event.text}`];
      case "reasoning":
        return event.content.kind === "text" && event.content.text !== ""
          ? [`${agent}[thinking] ${event.content.text}`]
          : [];
      case "tool_call_started": {
        const action = classifyTool(runtimeId, event.tool, event.input);
        started.set(`${event.agentPath.join("/")}|${event.callId}`, { tool: event.tool, kind: action.kind, detail: action.detail, receivedAt: event.receivedAt });
        const label = toolActionLabel(action.kind, "running");
        return [action.detail === undefined ? `${agent}[${label}]` : `${agent}[${label}] ${action.detail}`];
      }
      case "tool_call_input": {
        // Arguments that arrived after the start (an ACP runtime's later update): print the detail they add.
        const key = `${event.agentPath.join("/")}|${event.callId}`;
        const call = started.get(key);
        if (call === undefined) {
          return [];
        }
        const action = classifyTool(runtimeId, call.tool, event.input);
        if (action.detail === undefined || action.detail === call.detail) {
          return [];
        }
        started.set(key, { ...call, detail: action.detail });
        return [`${agent}[${toolActionLabel(action.kind, "running")}] ${action.detail}`];
      }
      case "tool_call_ended": {
        const key = `${event.agentPath.join("/")}|${event.callId}`;
        const call = started.get(key);
        started.delete(key);
        if (call === undefined) {
          return [`${agent}[${toolActionLabel("other", "done")}]`];
        }
        const seconds = ((event.receivedAt - call.receivedAt) / 1000).toFixed(1);
        return [`${agent}[${toolActionLabel(call.kind, "done")}] (${seconds}s)`];
      }
      case "turn_ended":
        return [`${agent}${renderOutcome(event.outcome)}`];
      case "compaction_started":
        return [`${agent}[compacting${event.trigger === undefined ? "" : `: ${event.trigger}`}]`];
      case "compaction_ended":
        if (event.outcome === "completed") {
          return [`${agent}[compacted]`];
        }
        return [`${agent}[compaction ${event.outcome}]${event.reason === undefined ? "" : ` ${event.reason}`}`];
      case "retry":
        return [`${agent}[retry ${String(event.attempt)}${event.maxAttempts === undefined ? "" : `/${String(event.maxAttempts)}`}]${event.reason === undefined ? "" : ` ${event.reason}`}`];
      case "app_request":
        return [`${agent}[waiting for app: ${event.type}]`];
      case "control_rejected":
        return [`${agent}[${event.action} rejected] ${event.reason}`];
      case "exited":
        return [`${agent}[runtime exited${event.code === null ? "" : `: ${String(event.code)}`}]`];
      case "task_started":
        return event.ambient === true ? [] : [`${agent}[task ${event.taskType} started]${event.description === undefined ? "" : ` ${event.description}`}`];
      case "task_ended":
        return [`${agent}[task ${event.status}]${event.summary === undefined ? "" : ` ${event.summary}`}`];
      case "turn_started":
      case "tool_call_progress":
      case "app_answered":
      case "input_withdrawn":
      case "user_message":
      case "usage":
      case "model":
      case "effort":
      case "task_updated":
        return [];
    }
    return [];
  };
}
