import type { ControlAction, CredentialProblem, FailureClass, RunningPhase, TaskStatus, TurnOutcome } from "../contracts/session.js";
import type { ViewNotice } from "./session-view.js";
import { classifyTool, toolActionLabel } from "./tool-activity.js";

/** English display wording may change in a minor release. Use the types, not these strings, for decisions. */
export type NoticeTone = "quiet" | "warning" | "danger";

function unreachable(value: never): never {
  throw new Error(`Unknown display value: ${String(value)}`);
}

function outcomeLabel(kind: TurnOutcome["kind"]): string {
  switch (kind) {
    case "completed": return "completed";
    case "aborted": return "aborted";
    case "failed": return "failed";
    default: return unreachable(kind);
  }
}

function outcomeTone(kind: TurnOutcome["kind"]): NoticeTone {
  switch (kind) {
    case "completed": return "quiet";
    case "aborted": return "warning";
    case "failed": return "danger";
    default: return unreachable(kind);
  }
}

function actionLabel(action: ControlAction): string {
  switch (action) {
    case "prompt": return "Prompt";
    case "steer": return "Steer";
    case "queue": return "Queue";
    case "withdraw": return "Withdraw";
    case "abort": return "Abort";
    case "dispose": return "Dispose";
    default: return unreachable(action);
  }
}

function detail(text: string, reason: string | undefined): string {
  return reason === undefined || reason === "" ? text : `${text}: ${reason}`;
}

/** A notice's English display text, including native reasons when present. Never parse this wording. */
export function noticeText(notice: ViewNotice): string {
  switch (notice.cause) {
    case "compaction_started":
      return detail("Compacting context", notice.trigger);
    case "compaction_ended": {
      const trigger = notice.trigger === undefined || notice.trigger === "" ? "" : ` (${notice.trigger})`;
      return detail(`Context compaction ${outcomeLabel(notice.outcome)}${trigger}`, notice.reason);
    }
    case "retry": {
      const maximum = notice.maxAttempts === undefined ? "" : ` of ${notice.maxAttempts}`;
      const delay = notice.delayMs === undefined ? "" : `, in ${notice.delayMs / 1000}s`;
      return detail(`Retrying (attempt ${notice.attempt}${maximum}${delay})`, notice.reason);
    }
    case "control_rejected":
      return detail(`${actionLabel(notice.action)} rejected`, notice.reason);
    case "child_turn_ended":
      return detail(`Subagent turn ${outcomeLabel(notice.outcome.kind)}`, notice.outcome.kind === "failed" ? notice.outcome.reason : undefined);
    case "exited":
      return notice.code === null ? "Runtime exited" : `Runtime exited (code ${notice.code})`;
    default:
      return unreachable(notice);
  }
}

/** Display emphasis for a notice; a host chooses its colors and presentation. */
export function noticeTone(notice: ViewNotice): NoticeTone {
  switch (notice.cause) {
    case "compaction_started": return "quiet";
    case "compaction_ended": return outcomeTone(notice.outcome);
    case "retry": return "warning";
    case "control_rejected": return "warning";
    case "child_turn_ended": return outcomeTone(notice.outcome.kind);
    case "exited": return notice.code === 0 ? "quiet" : (notice.code === null ? "warning" : "danger");
    default: return unreachable(notice);
  }
}

/** An MCP tool's own name (`mcp__server__tool` → `tool`); any other tool id as it is. */
function shortToolName(tool: string): string {
  const separator = tool.lastIndexOf("__");
  return tool.startsWith("mcp__") && separator > "mcp__".length ? tool.slice(separator + 2) : tool;
}

/**
 * The running phase in English, for display only. With `runtimeId`, a running call reads as its action
 * (`classifyTool`: "Editing file", "Running command"); an MCP or
 * unclassified tool by its short name. Without it, the tool id as reported.
 * A call whose arguments are still streaming reads as preparing its action
 * ("Preparing file edit"), or "Writing <tool> arguments" for an MCP or
 * unclassified tool.
 */
export function phaseLabel(phase: RunningPhase, runtimeId?: string): string {
  if (typeof phase === "object" && "tool" in phase) {
    const name = runtimeId === undefined ? phase.tool : shortToolName(phase.tool);
    const state = phase.writing === true ? "writing" : "running";
    const kind = runtimeId === undefined ? "other" : classifyTool(runtimeId, phase.tool).kind;
    if (kind !== "other" && kind !== "mcp") { return toolActionLabel(kind, state); }
    return state === "writing" ? `Writing ${name} arguments` : `Running ${name}`;
  }
  switch (phase) {
    case "waiting_model": return "Waiting for model";
    case "thinking": return "Thinking";
    case "responding": return "Responding";
    case "compacting": return "Compacting context";
    default: return unreachable(phase);
  }
}

function authText(runtimeName: string, credential: CredentialProblem | undefined): string {
  switch (credential) {
    case "missing": return `${runtimeName} is not signed in.`;
    case "rejected": return `${runtimeName}'s credentials were rejected.`;
    case undefined: return `${runtimeName} could not authenticate.`;
    default: return unreachable(credential);
  }
}

/**
 * What the runtime reported, in English. The host supplies any sign-in or
 * recovery guidance. `credential` (a failed outcome's) words `auth` as a
 * missing login or a refused credential when the runtime said which.
 */
export function failureText(failure: FailureClass, runtimeName: string, credential?: CredentialProblem): string {
  switch (failure) {
    case "auth": return authText(runtimeName, credential);
    case "quota": return `${runtimeName} reported that its usage limit was reached.`;
    case "rate_limited": return `${runtimeName} was rate limited by its provider.`;
    case "billing": return `${runtimeName} reported a billing or credit problem.`;
    case "model_unavailable": return `${runtimeName} cannot use the selected model.`;
    case "input_too_large": return `${runtimeName} reported that the input is too large for the model.`;
    case "invalid_request": return `${runtimeName} rejected the request as invalid.`;
    case "overloaded": return `${runtimeName} reported that its provider is overloaded.`;
    case "provider": return `${runtimeName} reported a provider error.`;
    case "runtime_exited": return `${runtimeName} exited before the turn finished.`;
    case "unknown": return "The turn failed.";
    default: return unreachable(failure);
  }
}

/** A task's status in English, for display only. */
export function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "pending": return "Pending";
    case "running": return "Running";
    case "paused": return "Paused";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "stopped": return "Stopped";
    default: return unreachable(status);
  }
}
