import { expect, test } from "vitest";
import type { RawEvent, TokenTotals } from "../packages/oar/src/contracts/session.js";
import { usageOf, viewOf } from "../packages/oar/src/observe/index.js";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";
import { addTokens, subtractTokens } from "../packages/oar/src/shared/token-totals.js";
import { grokPromptTokens } from "../packages/oar/src/runtimes/grok/session.js";
import { grokSpontaneousTokens } from "../packages/oar/src/runtimes/grok/spontaneous-usage.js";

test("reasoning arithmetic preserves absence, zero and output independently", () => {
  const bare = { input: 10, output: 5 };
  expect(addTokens(bare, bare)).toEqual({ input: 20, output: 10 });
  expect(addTokens(bare, { ...bare, reasoning: 0 })).toEqual({ input: 20, output: 10, reasoning: 0 });
  expect(addTokens({ ...bare, reasoning: 3 }, bare)).toEqual({ input: 20, output: 10, reasoning: 3 });
  expect(subtractTokens(bare, { input: 1, output: 1, reasoning: 1 })).toEqual({ input: 9, output: 4 });
  expect(subtractTokens({ ...bare, reasoning: 3 }, { input: 1, output: 1 })).toEqual({ input: 9, output: 4, reasoning: 3 });
});

test.each([undefined, 0, 4])("Grok prompt and independent wake ledgers preserve native reasoning %s", (reasoning) => {
  const usage = { inputTokens: 10, outputTokens: 5, ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }) };
  const tokens = { input: 10, output: 5, ...(reasoning === undefined ? {} : { reasoning }) };
  expect(grokPromptTokens({ _meta: { usage } })).toEqual(tokens);
  expect(grokSpontaneousTokens("_x.ai/session_notification", {
    _meta: { eventId: "event-1" },
    update: { sessionUpdate: "turn_completed", prompt_id: "subagent-completed-child", usage },
  })).toEqual({ key: "event-1", tokens });
});

test("a native session total keeps its reported reasoning remainder", () => {
  const kernel = createSessionKernel("root");
  kernel.frame({ type: "usage", native: {}, events: [{ kind: "usage", usage: {
    tokens: { input: 10, output: 5, reasoning: 2 }, total: { input: 30, output: 12, reasoning: 6 },
  } }] });
  expect(usageOf(kernel.records()).value).toMatchObject({
    total: { input: 30, output: 12, reasoning: 6 }, unattributed: { input: 20, output: 7, reasoning: 4 },
  });
  expect(viewOf(kernel.records()).usage).toEqual(usageOf(kernel.records()).value);
});

// oxlint-disable-next-line eslint/max-statements -- Root, agent and child cumulative reports are compared live and after JSON persistence.
test("reasoning sums by agent and child once and survives JSON replay", () => {
  const kernel = createSessionKernel("root");
  const report = (tokens: TokenTotals, sessionId = "root", agentPath: readonly string[] = []): void => {
    kernel.frame({ type: "usage", native: tokens, events: [{ kind: "usage", usage: { tokens } }] }, { sessionId, agentPath });
  };
  report({ input: 10, output: 5, reasoning: 2 });
  report({ input: 20, output: 7 }, "root", ["agent"]);
  report({ input: 30, output: 8, reasoning: 3 }, "child");
  report({ input: 40, output: 9, reasoning: 4 }, "child");
  kernel.frame({ type: "lineage", native: {}, events: [kernel.link({ parent: "root", child: "child", via: "tool_call" })] });
  const expected = { total: { input: 30, output: 12, reasoning: 2 }, withChildren: { input: 70, output: 21, reasoning: 6 } };
  expect(usageOf(kernel.records(), "root").value).toMatchObject(expected);
  // oxlint-disable-next-line typescript/no-unsafe-assignment, unicorn/prefer-structured-clone -- JSON is the persisted record boundary.
  const saved: RawEvent[] = JSON.parse(JSON.stringify(kernel.records()));
  expect(viewOf(saved).usage).toEqual(usageOf(kernel.records(), "root").value);
  expect(usageOf(saved, "root").value).toMatchObject(expected);
});
