import {
  classifyTool,
  toolActionLabel,
  type SessionRecord,
  type ToolActionKind,
  type TurnOutcome,
} from "@botiverse/oar";

// Pure rendering of session records into human-readable progress lines.
// Assistant text prints verbatim; everything else prints as a bracketed
// meta line so the two are distinguishable at a glance. Feed records
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

// Returns the printable lines for one record — possibly none: control
// records, uninterpreted frames, redacted/empty reasoning and empty text
// print nothing. A record with several views (one claude assistant message
// with thinking + text + tool_use) prints one line per view, in frame order.
export function createProgressRenderer(
  runtimeId: string,
): (record: SessionRecord) => readonly string[] {
  const started = new Map<string, StartedCall>();
  return (record) => {
    if (record.kind !== "event") {
      return [];
    }
    const agent = record.agentPath.length === 0 ? "" : `[${record.agentPath.join("/")}] `;
    const lines: string[] = [];
    for (const view of record.body.views) {
      switch (view.kind) {
        case "text_delta":
          if (view.text !== "") {
            lines.push(`${agent}${view.text}`);
          }
          break;
        case "reasoning":
          if (view.content.kind === "text" && view.content.text !== "") {
            lines.push(`${agent}[thinking] ${view.content.text}`);
          }
          break;
        case "tool_call_started": {
          const action = classifyTool(runtimeId, view.tool, view.input);
          started.set(`${record.agentPath.join("/")}|${view.callId}`, { kind: action.kind, receivedAt: record.receivedAt });
          const label = toolActionLabel(action.kind, "running");
          lines.push(action.detail === undefined ? `${agent}[${label}]` : `${agent}[${label}] ${action.detail}`);
          break;
        }
        case "tool_call_ended": {
          const key = `${record.agentPath.join("/")}|${view.callId}`;
          const call = started.get(key);
          started.delete(key);
          if (call === undefined) {
            lines.push(`${agent}[${toolActionLabel("other", "done")}]`);
          } else {
            const seconds = ((record.receivedAt - call.receivedAt) / 1000).toFixed(1);
            lines.push(`${agent}[${toolActionLabel(call.kind, "done")}] (${seconds}s)`);
          }
          break;
        }
        case "turn_ended":
          lines.push(`${agent}${renderOutcome(view.outcome)}`);
          break;
        case "usage":
        case "model":
          break;
      }
    }
    return lines;
  };
}
