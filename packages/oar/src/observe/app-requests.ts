import { asRecord, asRecordList, type JsonRecord } from "../shared/json.js";

/**
 * What a runtime→app request asks for, read off its `type`: the `type` of an
 * `app_request` event, view part or pending request (the runtime's native
 * method or subtype of a `toApp` request). Each runtime names the same ask
 * differently (ACP `session/request_permission`, codex
 * `item/commandExecution/requestApproval`, claude `can_use_tool`); only OAR
 * knows the mapping, so it lives here, as `classifyTool`'s does. Pure: the
 * request record stays the source of truth.
 *
 * - `approval`: may the agent go ahead with an action (a tool call, a command, a file change)?
 * - `question`: the agent, or an MCP server through it, asks the user for input.
 * - `service`: a client call the adapter serves itself (an ACP terminal or file); no person is asked.
 * - `unknown`: a type OAR does not recognise. The set is OPEN (runtimes add
 *   methods), so an unrecognised type is `unknown` rather than force-fit, and a
 *   host keeps showing it.
 */
export type AppRequestKind = "approval" | "question" | "service" | "unknown";

/**
 * Type → kind. The names are distinct across runtimes, so the type alone
 * decides. Where each name comes from:
 * - ACP (kimi, grok, antigravity): the client methods of
 *   `@agentclientprotocol/sdk` 1.4.0 (`methods.client`); shared/acp/client-app.ts
 *   serves the permission and terminal ones and records each as a `toApp`
 *   request. OAR advertises no `fs` capability and serves no elicitation, so
 *   no recorded request carries those yet.
 * - codex: the app-server's server requests, which the adapter records under
 *   their method (codex/session.ts), as `codex app-server
 *   generate-json-schema` lists them in 0.160.0. The legacy
 *   `execCommandApproval` / `applyPatchApproval` answer only turns started
 *   through the v1 APIs, which OAR does not use.
 * - claude: the `control_request` subtypes claude 2.1.288 sends its host,
 *   recorded under the subtype (claude/projection.ts).
 * - morph (community): the approval a task waits on (community/morph/tracker.ts).
 */
const KINDS: ReadonlyMap<string, AppRequestKind> = new Map<string, AppRequestKind>([
  ["session/request_permission", "approval"],
  ["elicitation/create", "question"],
  ["terminal/create", "service"],
  ["terminal/output", "service"],
  ["terminal/wait_for_exit", "service"],
  ["terminal/kill", "service"],
  ["terminal/release", "service"],
  ["fs/read_text_file", "service"],
  ["fs/write_text_file", "service"],

  ["item/commandExecution/requestApproval", "approval"],
  ["item/fileChange/requestApproval", "approval"],
  ["item/permissions/requestApproval", "approval"],
  ["item/tool/requestUserInput", "question"],
  ["mcpServer/elicitation/request", "question"],

  ["can_use_tool", "approval"],
  ["elicitation", "question"],

  ["approval", "approval"],
]);

/** Classify a runtime→app request by its `type` (an `app_request`'s method or subtype). */
export function appRequestKind(type: string): AppRequestKind {
  return KINDS.get(type) ?? "unknown";
}

type Texts = (body: JsonRecord) => unknown;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Type → where its words are, in the recorded body (the `toApp` request's
 * native body; claude's is the whole `control_request` frame, the ask in its
 * `request`). Sources: claude 2.1.292 (`elicitation` carries `message`,
 * `can_use_tool` carries `tool_name`); codex 0.160.1 `generate-json-schema`
 * (`McpServerElicitationRequestParams.message`,
 * `ToolRequestUserInputParams.questions[].question`,
 * `CommandExecutionRequestApprovalParams.command`); ACP SDK 1.4.0
 * (`CreateElicitationRequest.message`, `RequestPermissionRequest.toolCall.title`).
 */
const TEXTS: ReadonlyMap<string, Texts> = new Map<string, Texts>([
  ["elicitation", (body) => asRecord(body.request)?.message],
  ["can_use_tool", (body) => asRecord(body.request)?.tool_name],
  ["mcpServer/elicitation/request", (body) => body.message],
  ["item/tool/requestUserInput", (body) => asRecordList(body.questions).flatMap((question) => text(question.question) ?? []).join("\n")],
  ["item/commandExecution/requestApproval", (body) => body.command],
  ["elicitation/create", (body) => body.message],
  ["session/request_permission", (body) => asRecord(body.toolCall)?.title],
]);

/**
 * The words of a runtime→app request, read off its native body: what a
 * question asks, or the action an approval is for (a tool name, a command).
 * `body` is the one a pending request or an `app_request` view part carries.
 * Undefined for a type OAR does not know the words of, and when the body does
 * not hold them: never guessed.
 */
export function appRequestText(type: string, body: unknown): string | undefined {
  const record = asRecord(body);
  const read = TEXTS.get(type);
  return read === undefined || record === null ? undefined : text(read(record));
}
