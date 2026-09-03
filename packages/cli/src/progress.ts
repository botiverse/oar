import {
  classifyTool,
  toolActionLabel,
  type SessionEvent,
  type ToolActionKind,
  type TurnOutcome,
} from "@botiverse/oar";

// Pure rendering of session events into human-readable progress lines.
// Assistant text prints verbatim; everything else prints as a bracketed
// meta line so the two are distinguishable at a glance. Feed events
// through `aggregateDeltas` first so text arrives in whole blocks.

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

// Returns one printable line per event, or null when there is nothing worth
// showing (turn_started, redacted/empty reasoning, empty text).
export function createProgressRenderer(
  runtimeId: string,
): (event: SessionEvent) => string | null {
  const started = new Map<string, StartedCall>();
  return (event) => {
    switch (event.kind) {
      case "turn_started":
        return null;
      case "text_delta":
        return event.text === "" ? null : event.text;
      case "reasoning":
        return event.content.kind === "text" && event.content.text !== ""
          ? `[thinking] ${event.content.text}`
          : null;
      case "tool_call_started": {
        const action = classifyTool(runtimeId, event.tool, event.input);
        started.set(event.callId, { kind: action.kind, receivedAt: event.receivedAt });
        const label = toolActionLabel(action.kind, "running");
        return action.detail === undefined ? `[${label}]` : `[${label}] ${action.detail}`;
      }
      case "tool_call_ended": {
        const call = started.get(event.callId);
        started.delete(event.callId);
        if (call === undefined) {
          return `[${toolActionLabel("other", "done")}]`;
        }
        const seconds = ((event.receivedAt - call.receivedAt) / 1000).toFixed(1);
        return `[${toolActionLabel(call.kind, "done")}] (${seconds}s)`;
      }
      case "turn_ended":
        return renderOutcome(event.outcome);
    }
    return null;
  };
}
