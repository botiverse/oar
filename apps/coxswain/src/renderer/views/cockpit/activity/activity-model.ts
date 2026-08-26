import {
  classifyTool,
  toolActionLabel,
  type ToolActionKind,
} from "@botiverse/oar/observe";
import type { SessionEventView, TurnOutcomeView } from "../../../../shared/ipc.js";

export type ToolActivityState = "running" | "done" | "failed";

export type FriendlyActivityRow =
  | {
      readonly kind: "turn";
      readonly state: "started" | "completed" | "aborted" | "failed";
      readonly turnId: string;
      readonly seq: number;
      readonly receivedAt: number;
      readonly outcome?: TurnOutcomeView;
    }
  | {
      readonly kind: "phase";
      readonly phase: "thinking" | "responding";
      readonly turnId: string;
      readonly firstSeq: number;
      readonly lastSeq: number;
      readonly startedAt: number;
      readonly lastAt: number;
      readonly text: string;
    }
  | {
      readonly kind: "tool";
      readonly actionKind: ToolActionKind;
      readonly state: ToolActivityState;
      readonly label: string;
      readonly callId: string;
      readonly turnId: string;
      readonly firstSeq: number;
      readonly lastSeq: number;
      readonly startedAt: number;
      readonly lastAt: number;
      readonly detail?: string;
      readonly output?: string;
    };

function phaseOf(event: SessionEventView): {
  readonly phase: "thinking" | "responding";
  readonly text: string;
} | null {
  if (event.kind === "text_delta") {
    return { phase: "responding", text: event.text };
  }
  if (event.kind !== "reasoning") {
    return null;
  }
  return {
    phase: "thinking",
    text: event.content.kind === "text" ? event.content.text : "",
  };
}

function toolKey(turnId: string, callId: string): string {
  return `${turnId}\u0000${callId}`;
}

function turnState(outcome: TurnOutcomeView): "completed" | "aborted" | "failed" {
  return outcome.kind;
}

function closeRunningTools(
  rows: FriendlyActivityRow[],
  turnId: string,
  event: Extract<SessionEventView, { readonly kind: "turn_ended" }>,
): void {
  if (event.outcome.kind === "completed") {
    return;
  }
  for (const [index, row] of rows.entries()) {
    if (row.kind === "tool" && row.turnId === turnId && row.state === "running") {
      rows[index] = {
        ...row,
        state: "failed",
        label: toolActionLabel(row.actionKind, "failed"),
        lastSeq: event.seq,
        lastAt: event.receivedAt,
      };
    }
  }
}

/**
 * Derive the compact, human-facing Activity timeline from the raw event log.
 * Tool starts and ends share one row keyed by turn + call id. Raw events remain
 * untouched and are rendered independently by the Raw view.
 */
export function friendlyActivityRows(
  runtimeId: string,
  events: readonly SessionEventView[],
): readonly FriendlyActivityRow[] {
  const rows: FriendlyActivityRow[] = [];
  const toolIndexes = new Map<string, number>();

  for (const event of events) {
    const phase = phaseOf(event);
    if (phase !== null) {
      const previous = rows.at(-1);
      if (previous?.kind === "phase"
        && previous.phase === phase.phase
        && previous.turnId === event.turnId) {
        rows[rows.length - 1] = {
          ...previous,
          lastSeq: event.seq,
          lastAt: event.receivedAt,
          text: `${previous.text}${phase.text}`,
        };
      } else {
        rows.push({
          kind: "phase",
          phase: phase.phase,
          turnId: event.turnId,
          firstSeq: event.seq,
          lastSeq: event.seq,
          startedAt: event.receivedAt,
          lastAt: event.receivedAt,
          text: phase.text,
        });
      }
    } else {
      switch (event.kind) {
        case "turn_started":
          rows.push({
            kind: "turn",
            state: "started",
            turnId: event.turnId,
            seq: event.seq,
            receivedAt: event.receivedAt,
          });
          break;
        case "tool_call_started": {
          const action = classifyTool(runtimeId, event.tool, event.input);
          const row: FriendlyActivityRow = {
            kind: "tool",
            actionKind: action.kind,
            state: "running",
            label: toolActionLabel(action.kind, "running"),
            callId: event.callId,
            turnId: event.turnId,
            firstSeq: event.seq,
            lastSeq: event.seq,
            startedAt: event.receivedAt,
            lastAt: event.receivedAt,
            ...(action.detail === undefined ? {} : { detail: action.detail }),
          };
          toolIndexes.set(toolKey(event.turnId, event.callId), rows.length);
          rows.push(row);
          break;
        }
        case "tool_call_ended": {
          const index = toolIndexes.get(toolKey(event.turnId, event.callId));
          const row = index === undefined ? undefined : rows[index];
          if (index !== undefined && row?.kind === "tool") {
            rows[index] = {
              ...row,
              state: "done",
              label: toolActionLabel(row.actionKind, "done"),
              lastSeq: event.seq,
              lastAt: event.receivedAt,
              ...(event.output === undefined ? {} : { output: event.output }),
            };
          } else {
            rows.push({
              kind: "tool",
              actionKind: "other",
              state: "done",
              label: toolActionLabel("other", "done"),
              callId: event.callId,
              turnId: event.turnId,
              firstSeq: event.seq,
              lastSeq: event.seq,
              startedAt: event.receivedAt,
              lastAt: event.receivedAt,
              detail: event.callId,
              ...(event.output === undefined ? {} : { output: event.output }),
            });
          }
          break;
        }
        case "turn_ended":
          closeRunningTools(rows, event.turnId, event);
          rows.push({
            kind: "turn",
            state: turnState(event.outcome),
            turnId: event.turnId,
            seq: event.seq,
            receivedAt: event.receivedAt,
            outcome: event.outcome,
          });
          break;
        case "text_delta":
        case "reasoning":
          throw new Error("Phase events must be handled before the event switch");
      }
    }
  }

  return rows;
}
