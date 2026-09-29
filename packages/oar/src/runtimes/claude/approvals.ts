import type { AdapterSession, AppAsk, AppDecision, AskChoice, AskQuestion, SessionOptions } from "../../contracts/session.js";
import { answerList, type AnswerDelivery } from "../../shared/app-requests.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import type { SessionKernel } from "../../shared/session-kernel.js";

/*
 * claude's permission gate over stream-json (claude 2.1.284, probed
 * 2026-09-29 against a scripted provider; experiments/approval-channels.ts):
 * - `--permission-mode default --permission-prompt-tool stdio` (no
 *   `--dangerously-skip-permissions`) turns the gate on and routes it to the
 *   host: for each tool call its rules do not settle, claude writes
 *   `{type: "control_request", request_id, request: {subtype: "can_use_tool",
 *   tool_name, display_name, input, description?, title?, decision_reason?,
 *   permission_suggestions?, blocked_path?, tool_use_id,
 *   requires_user_interaction?, suppress_always_allow_rule?}}` after the
 *   `assistant` frame carrying the tool_use, then waits: an answer five
 *   minutes later ran the tool; no keep_alive frames meanwhile.
 * - The answer is `{type: "control_response", response: {subtype: "success",
 *   request_id, response: {behavior: "allow", updatedInput?,
 *   updatedPermissions?} | {behavior: "deny", message}}}`. `message` is
 *   required: a bare deny still denies, but the model reads "The canUseTool
 *   callback returned an invalid permission result". The deny message reaches
 *   the model verbatim as an `is_error` tool_result; the turn goes on.
 * - `updatedPermissions` with claude's own `addRules` suggestion, its
 *   destination set to `session`, let the same command run again unasked.
 * - `AskUserQuestion` is a `can_use_tool` too (`requires_user_interaction`,
 *   `input.questions`); the answer is `updatedInput: {...input, answers:
 *   {<question text>: "<label>[, <label>…]"}}`, which the model reads back as
 *   `"<question>"="<answer>"`.
 * - An interrupt while a request is pending: claude writes
 *   `{type: "control_cancel_request", request_id}` for it before the
 *   interrupt's own control_response, and ignores a later answer.
 */

/** What oar tells the model when a host denies without a message: claude requires one. */
export const CLAUDE_DENY_MESSAGE = "The user denied this tool use.";

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sessionRule(suggestion: JsonRecord): JsonRecord {
  return { ...suggestion, destination: "session" };
}

function remembersAction(suggestion: JsonRecord | null): suggestion is JsonRecord {
  return (suggestion?.type === "addRules" && suggestion.behavior === "allow") || suggestion?.type === "addDirectories";
}

/**
 * The grant `allow` with scope `session` sends: claude's own suggestions for
 * not asking again, each kept to this session (never written to a settings
 * file). Its allow rule for the command, and the directory the action
 * reaches outside the working ones (without it a rule for a path elsewhere
 * still asks: claude-aimock). Not a `setMode` suggestion: switching the
 * session to acceptEdits would ungate every later edit, not this action.
 * Empty (no `allow_session`) when claude suggests no allow rule.
 */
function sessionRules(request: JsonRecord): JsonRecord[] {
  const suggestions = (Array.isArray(request.permission_suggestions) ? request.permission_suggestions : []).map((suggestion) => asRecord(suggestion));
  const remembered = suggestions.filter((suggestion) => remembersAction(suggestion));
  return remembered.some((suggestion) => suggestion.type === "addRules") ? remembered.map((suggestion) => sessionRule(suggestion)) : [];
}

function optionOf(option: JsonRecord): { readonly label: string; readonly description?: string } {
  const description = text(option.description);
  return description === undefined ? { label: String(option.label) } : { label: String(option.label), description };
}

function questionOf(entry: JsonRecord): AskQuestion {
  const header = text(entry.header);
  const options = (Array.isArray(entry.options) ? entry.options : []).map((option) => asRecord(option)).filter((option) => typeof option?.label === "string");
  return {
    id: String(entry.question),
    question: String(entry.question),
    ...(header === undefined ? {} : { header }),
    options: options.map((option) => optionOf(option ?? {})),
    multiSelect: entry.multiSelect === true,
    other: true,
  };
}

function questionsOf(input: JsonRecord | null): AskQuestion[] | null {
  if (!Array.isArray(input?.questions)) {
    return null;
  }
  return input.questions.map((entry) => asRecord(entry)).filter((entry) => typeof entry?.question === "string").map((entry) => questionOf(entry ?? {}));
}

function pathsOf(request: JsonRecord, input: JsonRecord | null): string[] {
  const paths = [request.blocked_path, input?.file_path, input?.notebook_path, input?.path]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...new Set(paths)];
}

/** What a `can_use_tool` request asks; undefined for any other control request. */
export function claudeAsk(message: JsonRecord): AppAsk | undefined {
  const request = asRecord(message.request);
  if (request?.subtype !== "can_use_tool") {
    return undefined;
  }
  const tool = typeof request.tool_name === "string" ? request.tool_name : "unknown";
  const input = asRecord(request.input);
  const questions = tool === "AskUserQuestion" ? questionsOf(input) : null;
  if (questions !== null) {
    return { kind: "question", questions, choices: ["answer", "deny"], denyMessage: true };
  }
  const callId = text(request.tool_use_id);
  const title = text(request.title) ?? text(request.description);
  const reason = text(request.decision_reason);
  const command = SHELL_TOOLS.has(tool) ? text(input?.command) : undefined;
  const paths = pathsOf(request, input);
  const remembers = sessionRules(request).length > 0 && request.suppress_always_allow_rule !== true;
  const choices: AskChoice[] = remembers ? ["allow", "allow_session", "deny"] : ["allow", "deny"];
  return {
    kind: "tool_approval",
    tool,
    ...(callId === undefined ? {} : { callId }),
    ...(title === undefined ? {} : { title }),
    ...(reason === undefined ? {} : { reason }),
    ...(request.input === undefined ? {} : { input: JSON.stringify(request.input) }),
    ...(command === undefined ? {} : { command }),
    ...(paths.length === 0 ? {} : { paths }),
    choices,
    denyMessage: true,
  };
}

function permissionResult(request: JsonRecord, decision: AppDecision): JsonRecord | null {
  const input = asRecord(request.input) ?? {};
  switch (decision.kind) {
    case "allow":
      return decision.scope === "session"
        ? { behavior: "allow", updatedInput: input, updatedPermissions: sessionRules(request) }
        : { behavior: "allow", updatedInput: input };
    case "deny":
      return { behavior: "deny", message: decision.message ?? CLAUDE_DENY_MESSAGE };
    case "answer": {
      // claude keys answers by question text, several labels joined as its own tool reads them back.
      const answers = Object.fromEntries(Object.entries(decision.answers).map(([question, value]) => [question, answerList(value).join(", ")]));
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }
    case "native":
      return asRecord(decision.native);
  }
  return null;
}

/**
 * The `control_response` line answering the `control_request` `message` with
 * `decision` (one its ask takes, or a native `response` payload), or why none
 * can be written.
 */
export function claudeReply(message: JsonRecord, decision: AppDecision): AnswerDelivery {
  const requestId = message.request_id;
  const result = permissionResult(asRecord(message.request) ?? {}, decision);
  if (typeof requestId !== "string") {
    return { kind: "rejected", code: "unsupported", reason: "this control_request carries no request_id to answer" };
  }
  if (result === null) {
    return { kind: "rejected", code: "unsupported", reason: "a native answer to claude is the control_response's `response` object" };
  }
  return { kind: "sent", native: { type: "control_response", response: { subtype: "success", request_id: requestId, response: result } } };
}

/** The permission flags for `SessionOptions.approvals`: YOLO, or claude's gate forced on (a settings `defaultMode` of bypassPermissions would otherwise run it ungated) and routed to stdio. */
export function claudePermissionArgs(options: SessionOptions): readonly string[] {
  return options.approvals === "ask"
    ? ["--permission-mode", "default", "--permission-prompt-tool", "stdio"]
    : ["--dangerously-skip-permissions"];
}

/** `Session.answer` for claude: the reply is a stdin line; claude acknowledges none, so what it does next (the tool running, the model reading a denial) is the stream's. */
export function claudeAnswerer(kernel: SessionKernel, write: (line: string) => void): AdapterSession["answer"] {
  return async (requestId, decision) => {
    await Promise.resolve();
    return kernel.answer(requestId, decision, (request, taken) => {
      const reply = claudeReply(asRecord(request.body.kind === "native" ? request.body.native : null) ?? {}, taken);
      if (reply.kind === "sent") {
        write(`${JSON.stringify(reply.native)}\n`);
      }
      return reply;
    });
  };
}
