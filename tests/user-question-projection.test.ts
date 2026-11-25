import { expect, test } from "vitest";
import { appRequestKind, appRequestText, userQuestionOf } from "../packages/oar/src/observe/index.js";

/** claude 2.1.332 and codex 0.172.0, as recorded (experiments/user-questions-2026-11-25.md). */
const CLAUDE = { type: "control_request", request_id: "r", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [
  { question: "Which sizes?", header: "Size", options: [{ label: "S", description: "s" }, { label: "M", description: "m" }], multiSelect: true },
] }, tool_use_id: "call_1", requires_user_interaction: true } };
const CODEX = { threadId: "t", turnId: "u", itemId: "call_1", questions: [
  { id: "color", header: "Color", question: "Which color?", isOther: true, isSecret: false, options: [{ label: "Red", description: "r" }] },
  { id: "key", header: "Key", question: "Your key?", isOther: false, isSecret: true, options: null },
], isBlocking: false, autoResolutionMs: null };

test("claude's question is told from its approvals by the body", () => {
  expect(appRequestKind("can_use_tool", CLAUDE)).toBe("question");
  expect(appRequestKind("can_use_tool")).toBe("approval");
  expect(appRequestKind("can_use_tool", { request: { tool_name: "Bash", input: {} } })).toBe("approval");
  expect(appRequestText("can_use_tool", CLAUDE)).toBe("Which sizes?");
  expect(appRequestText("can_use_tool", { request: { tool_name: "Bash", input: {} } })).toBe("Bash");
});

test("both native shapes read as one prompt", () => {
  expect(userQuestionOf("can_use_tool", CLAUDE)).toEqual({ questions: [
    { id: "Which sizes?", question: "Which sizes?", header: "Size", options: [{ label: "S", description: "s" }, { label: "M", description: "m" }], multiSelect: true, allowOther: true, secret: false },
  ] });
  expect(userQuestionOf("item/tool/requestUserInput", CODEX)).toEqual({ questions: [
    { id: "color", question: "Which color?", header: "Color", options: [{ label: "Red", description: "r" }], multiSelect: false, allowOther: true, secret: false },
    { id: "key", question: "Your key?", header: "Key", multiSelect: false, allowOther: true, secret: true },
  ] });
});

test.each([
  ["can_use_tool", { request: { tool_name: "Bash", input: { questions: [{ question: "q" }] } } }],
  ["can_use_tool", { request: { tool_name: "AskUserQuestion", input: { questions: [] } } }],
  ["item/tool/requestUserInput", { questions: [{ id: "a", question: "read" }, { id: "b" }] }],
  ["mcpServer/elicitation/request", { message: "Sign in?" }],
  ["item/tool/requestUserInput", undefined],
])("%s %j is no prompt", (type, body) => { expect(userQuestionOf(type, body)).toBeNull(); });
