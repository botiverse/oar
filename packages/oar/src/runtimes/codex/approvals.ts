import type { AdapterSession, AppAsk, AppDecision, AskQuestion } from "../../contracts/session.js";
import { answerList, type AnswerDelivery } from "../../shared/app-requests.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import type { AppServerClient, RpcId } from "./app-server-client.js";
import type { CodexProjectionState } from "./projection.js";

/*
 * codex's approval gate over app-server v2 (codex-cli 0.155.1, probed
 * 2026-09-29 against a scripted provider; experiments/approval-channels.ts):
 * - `approvalPolicy: "untrusted"` with `approvalsReviewer: "user"` on
 *   thread/start (and thread/resume: a resumed thread takes the policy of the
 *   resume) asks for every command outside codex's trusted set, whatever the
 *   sandbox. `on-request` under oar's danger-full-access sandbox asked for
 *   nothing: with nothing to escalate from, the model never asks.
 * - A gated command is `item/started` (its commandExecution item, the
 *   `tool_call_started`), then the server request
 *   `item/commandExecution/requestApproval {kind, threadId, turnId, itemId,
 *   command, cwd, commandActions, reason?, proposedExecpolicyAmendment?,
 *   availableDecisions}` with a numeric JSON-RPC id counted per connection,
 *   answered by `{decision}`. It waits: an answer seconds later ran the
 *   command. `accept` runs it; `acceptForSession` runs it and the same
 *   command runs unasked later; `decline` fails the item (`declined`) and the
 *   model reads "rejected by user", the turn going on; `cancel` also ends
 *   the turn `interrupted`. `availableDecisions` listed accept,
 *   acceptWithExecpolicyAmendment and cancel, yet decline and acceptForSession
 *   were honored all the same: it is the list codex suggests presenting.
 * - `serverRequest/resolved {threadId, requestId}` follows every
 *   resolution: after the client's answer, and after `turn/interrupt` cleared
 *   a pending request (then it comes after `turn/completed`). A later answer
 *   to a cleared request is ignored.
 * - `item/tool/requestUserInput` (questions) is offered to the model but
 *   refused in the Default collaboration mode ("request_user_input is
 *   unavailable in Default mode"), the only mode oar runs; its reading and
 *   answer follow the protocol schema. `item/fileChange/requestApproval`
 *   likewise follows the schema: the scripted provider could not drive
 *   codex's patch tool.
 */

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The changes of a fileChange item (`item/started`), which its approval request does not repeat. */
export type FileChanges = readonly JsonRecord[];

function optionOf(option: JsonRecord): { readonly label: string; readonly description?: string } {
  const description = text(option.description);
  return description === undefined ? { label: String(option.label) } : { label: String(option.label), description };
}

function questionOf(entry: JsonRecord): AskQuestion {
  const header = text(entry.header);
  const options = (Array.isArray(entry.options) ? entry.options : []).map((option) => asRecord(option)).filter((option) => typeof option?.label === "string");
  return {
    id: String(entry.id),
    question: typeof entry.question === "string" ? entry.question : "",
    ...(header === undefined ? {} : { header }),
    options: options.map((option) => optionOf(option ?? {})),
    multiSelect: false,
    other: entry.isOther === true,
  };
}

function questionsOf(params: JsonRecord): AskQuestion[] {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  return questions.map((entry) => asRecord(entry)).filter((entry) => typeof entry?.id === "string").map((entry) => questionOf(entry ?? {}));
}

/**
 * What a codex server request asks; undefined for requests that are no
 * person's approval or question oar has words for (MCP elicitation, dynamic
 * tool calls, token refreshes, `item/permissions/requestApproval`, whose
 * answer grants a permission profile).
 */
export function codexAsk(method: string, params: JsonRecord, changes: FileChanges | undefined): AppAsk | undefined {
  const callId = text(params.itemId);
  const reason = text(params.reason);
  const common = {
    ...(callId === undefined ? {} : { callId }),
    ...(reason === undefined ? {} : { reason }),
    choices: ["allow", "allow_session", "deny"] as const,
    denyMessage: false,
  };
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const command = text(params.command);
      const cwd = text(params.cwd);
      return {
        kind: "tool_approval",
        tool: "commandExecution",
        ...common,
        ...(command === undefined ? {} : { command }),
        ...(cwd === undefined ? {} : { cwd }),
      };
    }
    case "item/fileChange/requestApproval": {
      const paths = (changes ?? []).map((change) => change.path).filter((value): value is string => typeof value === "string");
      const diffs = (changes ?? []).map((change) => change.diff).filter((value): value is string => typeof value === "string" && value.length > 0);
      return {
        kind: "tool_approval",
        tool: "fileChange",
        ...common,
        ...(paths.length === 0 ? {} : { paths }),
        ...(diffs.length === 0 ? {} : { diff: diffs.join("\n") }),
      };
    }
    case "item/tool/requestUserInput":
      return { kind: "question", questions: questionsOf(params), choices: ["answer"], denyMessage: false };
    default:
      return undefined;
  }
}

const APPROVALS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);

/** The JSON-RPC `result` answering `method` with `decision` (one its ask takes, or a native result), or why there is none. */
export function codexResult(method: string, decision: AppDecision): { readonly result: unknown } | Extract<AnswerDelivery, { kind: "rejected" }> {
  if (decision.kind === "native") {
    return { result: decision.native };
  }
  if (method === "item/tool/requestUserInput" && decision.kind === "answer") {
    const answers = Object.fromEntries(Object.entries(decision.answers).map(([id, value]) => [id, { answers: [...answerList(value)] }]));
    return { result: { answers } };
  }
  if (APPROVALS.has(method) && decision.kind === "allow") {
    return { result: { decision: decision.scope === "session" ? "acceptForSession" : "accept" } };
  }
  if (APPROVALS.has(method) && decision.kind === "deny") {
    return { result: { decision: "decline" } };
  }
  return { kind: "rejected", code: "unsupported", reason: `codex ${method} takes no ${decision.kind} decision` };
}

/** Control plane → state: oar answered the server request `requestId` (its toApp record id). */
export function codexAnswered(state: CodexProjectionState, requestId: string): CodexProjectionState {
  return { ...state, answered: new Set([...state.answered, requestId]) };
}

/** The fileChange item `item/started` announced, forgotten at its `item/completed`: the projection keeps it for the approval request that names only the item. */
export function rememberFileChanges(state: CodexProjectionState, method: string, params: JsonRecord): CodexProjectionState {
  const item = asRecord(params.item);
  if (item?.type !== "fileChange" || typeof item.id !== "string") {
    return state;
  }
  const fileChanges = new Map(state.fileChanges);
  if (method === "item/started" && Array.isArray(item.changes)) {
    fileChanges.set(item.id, item.changes.map((change) => asRecord(change)).filter((change): change is JsonRecord => change !== null));
  } else if (method === "item/completed") {
    fileChanges.delete(item.id);
  }
  return { ...state, fileChanges };
}

/** The session's two halves of codex server requests: recording each (with what it asks) and answering one. */
export interface CodexAsking {
  readonly onServerRequest: (id: string, method: string, params: JsonRecord, rawId: RpcId) => void;
  readonly answer: AdapterSession["answer"];
}

/**
 * Server requests are toApp records under codex's own id (a child thread's
 * in the child session, like its frames); an answer is the JSON-RPC response
 * carrying that id back as sent, and marks the request answered so the
 * `serverRequest/resolved` that follows is no withdrawal.
 */
export function createCodexAsking(deps: {
  readonly kernel: SessionKernel;
  readonly client: AppServerClient;
  readonly threadId: string;
  /** The session's live projection state, read for a file change's diff and marked when oar answers. */
  readonly state: { projection: CodexProjectionState };
}): CodexAsking {
  const { kernel, client, threadId, state } = deps;
  const rawIds = new Map<string, RpcId>();
  return {
    onServerRequest(id, method, params, rawId) {
      rawIds.set(id, rawId);
      const child = typeof params.threadId === "string" && params.threadId !== threadId ? params.threadId : undefined;
      if (child !== undefined) {
        kernel.node(child);
      }
      const ask = codexAsk(method, params, state.projection.fileChanges.get(typeof params.itemId === "string" ? params.itemId : ""));
      kernel.request("toApp", { kind: "native", type: method, native: params, ...(ask === undefined ? {} : { ask }) }, {
        id,
        ...(child === undefined ? {} : { sessionId: child }),
        ...(typeof params.turnId === "string" ? { spanId: params.turnId } : {}),
      });
    },
    async answer(requestId, decision) {
      await Promise.resolve();
      return kernel.answer(requestId, decision, (request, taken) => {
        const result = codexResult(request.body.kind === "native" ? request.body.type : "", taken);
        if ("kind" in result) {
          return result;
        }
        state.projection = codexAnswered(state.projection, request.id);
        return { kind: "sent", native: client.respond(rawIds.get(request.id) ?? request.id, result.result) };
      });
    },
  };
}
