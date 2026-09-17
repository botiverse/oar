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
  readonly kind: ToolActionKind;
  readonly receivedAt: number;
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
// model reports, redacted/empty reasoning and empty text print nothing.
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
        started.set(`${event.agentPath.join("/")}|${event.callId}`, { kind: action.kind, receivedAt: event.receivedAt });
        const label = toolActionLabel(action.kind, "running");
        return [action.detail === undefined ? `${agent}[${label}]` : `${agent}[${label}] ${action.detail}`];
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
      case "turn_started":
      case "tool_call_progress":
      case "app_answered":
      case "user_message":
      case "usage":
      case "model":
        return [];
    }
    return [];
  };
}
