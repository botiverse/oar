import { claudeRuntime, codexRuntime, type RawEvent, type Runtime } from "../../../packages/oar/src/index.js";
import { viewOf, type ViewTurn } from "../../../packages/oar/src/observe/session-view.js";
import { asRecord } from "../../../packages/oar/src/shared/json.js";
import { startClaudeAimock, startCodexAimock, type AimockEnv, type LLMock } from "../../harness/aimock.js";

/*
 * Shared by the SessionOptions.fork vendor tests (session-fork*.vendor.test.ts):
 * the scripted provider and readers of what it received and what OAR recorded.
 */

export const forkOutputSchema = { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false };

/** Whether a codex goal should run its continuation turns now (the goal case). */
const goal = { active: false };
export function setForkGoalActive(active: boolean): void { goal.active = active; }

/**
 * "noted" to everything, except a 400 for a prompt naming FORK-FAIL (a failed
 * turn), a long shell command for one naming FORK-TOOL (a turn to abort);
 * claude: a `StructuredOutput` call for FORK-SCHEMA and a short shell command
 * for "run FORK-LOOP" (its output reads LOOP-DONE, which its input does not
 * spell); codex: two continuation rounds and a completion while a goal is active.
 */
function fixtures(claude: boolean): (mock: LLMock) => void {
  return (mock) => {
    mock.onMessage(/FORK-FAIL/u, { status: 400, error: { type: "invalid_request_error", ...(claude ? {} : { code: "invalid_request" }), message: "fork-fail" } });
    mock.on({ userMessage: /FORK-TOOL/u, hasToolResult: false }, { toolCalls: [{ id: "call-wait", name: claude ? "Bash" : "exec_command", arguments: JSON.stringify(claude ? { command: "for i in $(seq 60); do sleep 1; done" } : { cmd: "for i in $(seq 60); do sleep 1; done" }) }] });
    if (claude) {
      mock.on({ userMessage: /FORK-SCHEMA/u, hasToolResult: false }, { toolCalls: [{ name: "StructuredOutput", arguments: '{"answer":4}' }] });
      mock.on({ userMessage: /run FORK-LOOP/u, hasToolResult: false }, { toolCalls: [{ id: "call-loop", name: "Bash", arguments: JSON.stringify({ command: "printf 'LOOP%s' -DONE" }) }] });
    } else {
      mock.on({ predicate: (request) => goal.active && request.messages.at(-1)?.tool_call_id === "goal-completed" }, { content: "GOAL_FINISHED" });
      mock.on({ predicate: (request) => goal.active && JSON.stringify(request.messages).includes("WORK_ROUND_ONE") }, { toolCalls: [{ id: "goal-completed", name: "update_goal", arguments: '{"status":"complete"}' }] });
      mock.on({ predicate: () => goal.active }, { content: "WORK_ROUND_ONE" });
    }
    mock.onMessage(/[\s\S]*/u, { content: "noted" });
  };
}

export const forkSubjects: Readonly<Record<string, { readonly runtime: Runtime; readonly start: () => Promise<AimockEnv> }>> = {
  "claude-aimock": { runtime: claudeRuntime, start: async () => { const started = await startClaudeAimock(fixtures(true)); return started; } },
  "codex-aimock": { runtime: codexRuntime, start: async () => { const started = await startCodexAimock(fixtures(false)); return started; } },
};

export interface Turn { readonly role: string; readonly text: string }

/** The provider request that carried `marker` last (or first): the one the turn prompted with it sent. */
export function requestWith(env: AimockEnv, marker: string, which: "first" | "last" = "last"): unknown {
  const requests = env.mock.getRequests();
  const carries = (request: unknown): boolean => JSON.stringify(request).includes(marker);
  const found = which === "last" ? requests.findLast((request) => carries(request)) : requests.find((request) => carries(request));
  if (found === undefined) { throw new Error(`no provider request carried ${marker}`); }
  return found;
}

function textOf(content: unknown): string {
  if (typeof content === "string") { return content; }
  return Array.isArray(content) ? content.map((part) => { const text = asRecord(part)?.text; return typeof text === "string" ? text : ""; }).join("") : "";
}

/**
 * The conversation a provider request carried before its final user message
 * (the prompt that sent it): every user and assistant message, in order, as
 * the runtime replayed it. System prompts are left out.
 */
export function historyOf(request: unknown): Turn[] {
  const body = asRecord(asRecord(request)?.body);
  const messages: unknown[] = Array.isArray(body?.messages) ? body.messages : [];
  const turns = messages.map((message) => asRecord(message)).flatMap((message) => message?.role === "user" || message?.role === "assistant" ? [{ role: message.role, text: textOf(message.content) }] : []);
  const last = turns.findLastIndex((turn) => turn.role === "user");
  return turns.slice(0, last);
}

export function endedTurns(records: readonly RawEvent[]): ViewTurn[] {
  return viewOf(records).messages.filter((message): message is ViewTurn => message.kind === "turn" && message.outcome !== undefined);
}

/** The root turns' fork anchors, in order, from the session view of its records. */
export function anchors(records: readonly RawEvent[]): (string | undefined)[] {
  return endedTurns(records).map((turn) => turn.forkAnchor);
}

/** The titles claude reports for the session (`session_title_changed`). */
export function titles(records: readonly RawEvent[]): unknown[] {
  return records.flatMap((record) => {
    const native = record.kind === "frame" ? asRecord(record.body.native) : null;
    return native?.subtype === "session_title_changed" ? [native.title] : [];
  });
}

/** The ids of the turns codex reported completed on thread `threadId`, in order. */
export function codexTurnIds(records: readonly RawEvent[], threadId: string): string[] {
  return records.flatMap((record) => {
    const native = record.kind === "frame" && record.body.type === "turn/completed" ? asRecord(record.body.native) : null;
    const id = native?.threadId === threadId ? asRecord(native.turn)?.id : undefined;
    return typeof id === "string" ? [id] : [];
  });
}

/** How many root `usage` events the records hold, and how many of them carry `tokens`. */
export function tokenReports(records: readonly RawEvent[]): { readonly usage: number; readonly tokens: number } {
  const usage = records.flatMap((record) => record.kind === "frame" && record.agentPath.length === 0 ? record.body.events.flatMap((event) => event.kind === "usage" ? [event.usage] : []) : []);
  return { usage: usage.length, tokens: usage.filter((reading) => reading.tokens !== undefined).length };
}
