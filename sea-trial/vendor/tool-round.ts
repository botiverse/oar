import assert from "node:assert/strict";
import type { Session, SessionEvent } from "../../packages/oar/src/contracts/session.js";
import type { LLMock } from "../harness/aimock.js";
import { openTrace } from "../harness/trace.js";

// Vendor runs are runs too: their traces land in the same run directory the
// CI behavior jobs upload, so a red vendor test ships its trajectory.
openTrace(`vendor-${process.env.OAR_TEST ?? "unset"}`);

/**
 * A scripted two-round tool conversation: the provider first demands a tool
 * call, then (seeing its result) a second one, then answers. Drives the REAL
 * harness through real tool execution — what the multi-round tool tests share
 * across vendors; only the tool name/argument shape is vendor-specific.
 */
export function toolRoundFixtures(
  mock: LLMock,
  tool: (command: string) => { name: string; arguments: string },
): void {
  // hasToolResult flags keep the three stages mutually exclusive: without
  // them the opening fixture keeps matching follow-up requests (the original
  // user text stays in the conversation) and the runtime loops the tool
  // forever (observed: pi executed it 1143 times in 30s).
  mock.on({ userMessage: /run the tool/u, hasToolResult: false }, { toolCalls: [tool("echo oar-round-one")] });
  mock.on({ hasToolResult: true, toolResultContains: "oar-round-one" }, { toolCalls: [tool("echo oar-round-two")] });
  mock.on({ hasToolResult: true, toolResultContains: "oar-round-two" }, { content: "both rounds done" });
}

/** Structural skeleton of a turn: framing + tool lifecycle, deltas elided. */
export async function structuralToolRound(session: Session): Promise<readonly string[]> {
  const events: SessionEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
  });
  const result = session.prompt("please run the tool as instructed");
  assert.ok(result.kind === "turn", "expected a turn");
  const outcome = await result.turn.outcome;
  const skeleton = events
    .filter((event) => event.kind !== "text_delta" && event.kind !== "thinking_delta")
    .map((event) => {
      switch (event.kind) {
        case "tool_call_started":
          return `tool_call_started:${event.tool}`;
        case "turn_ended":
          return `turn_ended:${event.outcome.kind}`;
        case "turn_started":
        case "tool_call_ended":
          break;
      }
      return event.kind;
    });
  assert.deepEqual(outcome, { kind: "completed" });
  return skeleton;
}
