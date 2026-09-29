import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AppAsk, AppDecision, AskChoice } from "../../contracts/session.js";
import type { AnswerDelivery } from "../app-requests.js";
import { asRecord, type JsonRecord } from "../json.js";

/*
 * ACP's permission channel (protocol, @agentclientprotocol/sdk 1.4.0):
 * `session/request_permission {sessionId, toolCall: {toolCallId, title?,
 * kind?, content?, rawInput?, locations?}, options: [{optionId, name, kind:
 * allow_once | allow_always | reject_once | reject_always}]}`, answered by
 * `{outcome: {outcome: "selected", optionId} | {outcome: "cancelled"}}`. The
 * reply is a JSON-RPC response the agent waits for; the client "MUST respond
 * `cancelled`" to every pending request of a turn it cancels with
 * `session/cancel`. oar reads the options by kind: `allow` is the
 * `allow_once` option, `deny` the `reject_once` one. `allow_always` is the
 * agent's own "remember" choice, whose scope ACP does not say: it is
 * `allow_session` only where the profile knows it is session-scoped (kimi
 * 2.0.0 names it "Approve for this session"); elsewhere a host picks it with
 * a native reply.
 */

/** What a profile knows about its runtime's permission options beyond ACP's kinds. */
export interface AcpPermissionOptions {
  /** The runtime's `allow_always` option grants for this session only. */
  readonly allowAlwaysIsSession?: boolean;
}

/** The reply the protocol requires for a request of a cancelled turn. */
export const ACP_CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

function optionOf(params: RequestPermissionRequest, kind: "allow_once" | "allow_always" | "reject_once"): string | undefined {
  return params.options.find((option) => option.kind === kind)?.optionId;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The text of a ToolCallContent list (`[{type: "content", content: {type: "text", text}}]`): the agent's description of what it asks. */
function contentText(value: unknown): string | undefined {
  const parts = (Array.isArray(value) ? value : [])
    .map((entry) => asRecord(asRecord(entry)?.content)?.text)
    .filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.length === 0 ? undefined : parts.join("\n");
}

function choicesOf(params: RequestPermissionRequest, options: AcpPermissionOptions): AskChoice[] {
  const choices: AskChoice[] = [];
  if (optionOf(params, "allow_once") !== undefined) {
    choices.push("allow");
  }
  if (options.allowAlwaysIsSession === true && optionOf(params, "allow_always") !== undefined) {
    choices.push("allow_session");
  }
  if (optionOf(params, "reject_once") !== undefined) {
    choices.push("deny");
  }
  return choices;
}

/** What a `session/request_permission` asks. */
export function acpAsk(params: RequestPermissionRequest, options: AcpPermissionOptions = {}): AppAsk {
  const toolCall = asRecord(params.toolCall) ?? {};
  const rawInput = asRecord(toolCall.rawInput);
  const title = text(toolCall.title);
  const tool = text(toolCall.kind) ?? title ?? "unknown";
  const callId = text(toolCall.toolCallId);
  const reason = contentText(toolCall.content);
  const command = text(rawInput?.command);
  const cwd = text(rawInput?.cwd);
  const locations = Array.isArray(toolCall.locations) ? toolCall.locations : [];
  const paths = locations.map((location) => asRecord(location)?.path).filter((value): value is string => typeof value === "string");
  return {
    kind: "tool_approval",
    tool,
    ...(callId === undefined ? {} : { callId }),
    ...(title === undefined ? {} : { title }),
    ...(reason === undefined ? {} : { reason }),
    ...(toolCall.rawInput === undefined ? {} : { input: JSON.stringify(toolCall.rawInput) }),
    ...(command === undefined ? {} : { command }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(paths.length === 0 ? {} : { paths }),
    choices: choicesOf(params, options),
    denyMessage: false,
  };
}

function optionFor(params: RequestPermissionRequest, decision: AppDecision, options: AcpPermissionOptions): string | undefined {
  if (decision.kind === "allow" && decision.scope === "session") {
    return options.allowAlwaysIsSession === true ? optionOf(params, "allow_always") : undefined;
  }
  if (decision.kind === "allow") {
    return optionOf(params, "allow_once");
  }
  return decision.kind === "deny" ? optionOf(params, "reject_once") : undefined;
}

/** The `RequestPermissionResponse` for `decision` (one the ask takes, or a native response). */
export function acpPermissionReply(params: RequestPermissionRequest, decision: AppDecision, options: AcpPermissionOptions = {}): AnswerDelivery {
  if (decision.kind === "native") {
    const native = asRecord(decision.native);
    return native === null
      ? { kind: "rejected", code: "unsupported", reason: "a native answer to session/request_permission is a RequestPermissionResponse object" }
      : { kind: "sent", native };
  }
  const optionId = optionFor(params, decision, options);
  if (optionId === undefined) {
    return { kind: "rejected", code: "unsupported", reason: `this permission request offers no option for ${decision.kind}` };
  }
  const reply: JsonRecord = { outcome: { outcome: "selected", optionId } };
  return { kind: "sent", native: reply };
}
