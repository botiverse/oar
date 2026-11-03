import assert from "node:assert/strict";
import { getTextContent, type ChatCompletionRequest, type ChatMessage } from "@copilotkit/aimock";
import type { Session, RawEvent } from "../../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../../packages/oar/src/observe/turns.js";
import type { LLMock } from "../../harness/aimock.js";
import { openTrace, record } from "../../harness/trace.js";

// Vendor runs are runs too: their traces land in the same run directory the
// CI behavior jobs upload, so a red vendor test ships its trajectory.
openTrace(`vendor-${process.env.OAR_TEST ?? "unset"}`);

function toolRoundTurn(request: ChatCompletionRequest): { user: string; result: ChatMessage | undefined } {
  // Codex can append a native environment_context as a user message after
  // a tool result at UTC midnight. It is context for the same turn.
  const userIndex = request.messages.findLastIndex(message => message.role === "user"
    && !/^<environment_context>[\s\S]*<\/environment_context>$/u.test(getTextContent(message.content)?.trim() ?? ""));
  return {
    user: getTextContent(request.messages[userIndex]?.content ?? null) ?? "",
    result: request.messages.slice(userIndex + 1).findLast(message => message.role === "tool"),
  };
}

/**
 * A scripted two-round tool conversation: the provider first demands a tool
 * call, then (seeing its result) a second one, then answers. Drives the REAL
 * harness through real tool execution: what the multi-round tool tests share
 * across vendors; only the tool name/argument shape is vendor-specific.
 */
export function toolRoundFixtures(
  mock: LLMock,
  tool: (command: string) => { name: string; arguments: string },
): void {
  // The current turn's latest tool result keeps the stages mutually exclusive:
  // otherwise the opening fixture keeps matching follow-up requests (the original
  // user text stays in the conversation) and the runtime loops the tool
  // forever (observed: pi executed it 1143 times in 30s).
  mock.on({ predicate: request => {
    const turn = toolRoundTurn(request);
    return turn.result === undefined && /run the tool/u.test(turn.user);
  } }, { toolCalls: [tool("echo oar-round-one")] });
  mock.on({ predicate: request => getTextContent(toolRoundTurn(request).result?.content ?? null)?.includes("oar-round-one") === true }, { toolCalls: [tool("echo oar-round-two")] });
  mock.on({ predicate: request => getTextContent(toolRoundTurn(request).result?.content ?? null)?.includes("oar-round-two") === true }, { content: "both rounds done" });
}

/**
 * Structural skeleton of a turn from the ROOT agent's records: the control
 * records plus the tool lifecycle and turn end events, deltas and
 * uninterpreted frames elided. Records of one turn are those after the
 * prompt request up to and including the turn end.
 */
export function turnSkeleton(records: readonly RawEvent[], fromSeq: number): readonly string[] {
  const skeleton: string[] = [];
  for (const entry of records) {
    if (entry.seq < fromSeq || entry.agentPath.length > 0) {
      continue;
    }
    if (entry.kind === "request") {
      skeleton.push(`request:${entry.body.kind}`);
    } else if (entry.kind === "response") {
      skeleton.push(`response:${entry.body.kind}`);
    } else {
      for (const view of entry.body.events) {
        if (view.kind === "tool_call_started") {
          skeleton.push(`tool_call_started:${view.tool}`);
        } else if (view.kind === "tool_call_ended") {
          skeleton.push("tool_call_ended");
        } else if (view.kind === "turn_ended") {
          skeleton.push(`turn_ended:${view.outcome.kind}`);
          return skeleton;
        }
      }
    }
  }
  return skeleton;
}

/** Drive one prompt through the real harness and return its skeleton. On failure the error carries the mock's request journal: the CI flake's side of the story. */
export async function structuralToolRound(
  session: Session,
  mock?: LLMock,
  prompt = "please run the tool as instructed",
): Promise<readonly string[]> {
  const result = await session.prompt(prompt);
  assert.ok(result.response.body.kind === "accepted", `prompt not accepted: ${JSON.stringify(result.response.body)}`);
  const outcome = await awaitTurnEnd(session, result.request.seq);
  if (outcome.kind !== "completed" && mock !== undefined) {
    // Keep the raw tail visible in diagnostics, including native context
    // after a tool result that the fixture treats as part of the same turn.
    const requests = mock.journal.getAll().map((entry) => {
      const messages = entry.body?.messages ?? [];
      const lastUser = messages.findLast((message) => message.role === "user");
      const lastTool = messages.findLast((message) => message.role === "tool");
      const lastRole = messages.at(-1)?.role ?? "none";
      const text = typeof lastUser?.content === "string"
        ? lastUser.content
        : JSON.stringify(lastUser?.content ?? null);
      const toolText = lastTool === undefined
        ? null
        : (typeof lastTool.content === "string" ? lastTool.content : JSON.stringify(lastTool.content)).slice(-300);
      return JSON.stringify({
        lastRole,
        hasToolResult: lastTool !== undefined,
        lastUser: text.slice(-220),
        toolResult: toolText,
      });
    });
    record({ kind: "journal_dump", requests });
    throw new Error(`turn ${JSON.stringify(outcome)}; requests as the matcher saw them:\n${requests.join("\n")}`);
  }
  assert.deepEqual(outcome, { kind: "completed" });
  return turnSkeleton(session.records(), result.request.seq);
}
