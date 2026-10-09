import { expect, test } from "vitest";
import { appRequestText } from "../packages/oar/src/observe/index.js";
import { viewOf, type SessionView } from "../packages/oar/src/observe/session-view.js";
import { foldClaudeStdout, initialClaudeProjection, type ClaudeProjectionState } from "../packages/oar/src/runtimes/claude/projection.js";
import { foldCodexNotification, initialCodexProjection } from "../packages/oar/src/runtimes/codex/projection.js";
import { createSessionKernel, type SessionKernel } from "../packages/oar/src/shared/session-kernel.js";

// oar#263: a request the runtime withdrew leaves pendingRequests on the
// runtime's word, its part carries the body, and appRequestText reads it.

/** claude 2.1.292: an MCP server's elicitation, an interrupt, then claude's cancel under the same id. */
const ELICITATION = {
  type: "control_request",
  request_id: "a19c0ccb-9037-4733-9496-375c4762cfa2",
  request: { subtype: "elicitation", mcp_server_name: "ask", message: "Which color do you like?", mode: "form", requested_schema: { type: "object", properties: { color: { type: "string" } }, required: ["color"] } },
};
const CANCEL = { type: "control_cancel_request", request_id: "a19c0ccb-9037-4733-9496-375c4762cfa2" };

/** Apply claude's projection to a kernel the way the claude session does. */
function feed(kernel: SessionKernel, state: ClaudeProjectionState, message: Record<string, unknown>): ClaudeProjectionState {
  const { state: next, commands } = foldClaudeStdout(state, message);
  for (const command of commands) {
    if (command.kind === "frame") { kernel.frame(command.body, { agentPath: command.agentPath }); }
    if (command.kind === "toApp") { kernel.request("toApp", { kind: "native", type: command.type, native: command.native }, { id: command.id }); }
  }
  return next;
}

function asking(): { kernel: SessionKernel; state: ClaudeProjectionState } {
  const kernel = createSessionKernel("root");
  const prompt = kernel.request("toRuntime", { kind: "prompt", input: "Call the ask tool" });
  kernel.respond(prompt.id, { kind: "accepted" });
  return { kernel, state: feed(kernel, initialClaudeProjection, ELICITATION) };
}

function requestParts(view: SessionView) {
  return view.messages.flatMap((message) => message.kind === "turn"
    ? message.sections.flatMap((section) => section.parts.filter((part) => part.kind === "app_request"))
    : []);
}

test("the app_request part carries the native body, and appRequestText reads the ask off it", () => {
  const view = viewOf(asking().kernel.records());
  const [part] = requestParts(view);
  expect(part).toMatchObject({ requestId: ELICITATION.request_id, type: "elicitation", answered: false, body: ELICITATION });
  expect(view.pendingRequests.map((request) => request.requestId)).toEqual([ELICITATION.request_id]);
  expect(part?.kind === "app_request" ? appRequestText(part.type, part.body) : undefined).toBe("Which color do you like?");
});

test("claude's control_cancel_request takes the request out of pendingRequests and marks its part cancelled", () => {
  const { kernel, state } = asking();
  feed(kernel, state, CANCEL);
  const view = viewOf(kernel.records());
  expect(view.pendingRequests).toEqual([]);
  expect(requestParts(view)).toEqual([expect.objectContaining({ requestId: ELICITATION.request_id, answered: false, cancelled: true })]);
});

test("the exit empties pendingRequests; the part stays as it was", () => {
  const { kernel } = asking();
  kernel.respond("", { kind: "exited", code: 1 });
  const view = viewOf(kernel.records());
  expect(view.pendingRequests).toEqual([]);
  expect(requestParts(view)).toEqual([expect.objectContaining({ answered: false })]);
  expect(requestParts(view)[0]).not.toHaveProperty("cancelled");
});

test("codex serverRequest/resolved reads as app_request_cancelled, its numeric id as the recorded string", () => {
  const { commands } = foldCodexNotification(initialCodexProjection("thread-1"), "serverRequest/resolved", { threadId: "thread-1", requestId: 7 });
  expect(commands.flatMap((command) => command.kind === "frame" ? command.body.events : [])).toEqual([{ kind: "app_request_cancelled", requestId: "7" }]);
});

test("appRequestText reads each runtime's field, and never guesses", () => {
  expect({
    claudeApproval: appRequestText("can_use_tool", { type: "control_request", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } }),
    codexElicitation: appRequestText("mcpServer/elicitation/request", { serverName: "docs", threadId: "t", message: "Sign in?" }),
    codexQuestions: appRequestText("item/tool/requestUserInput", { questions: [{ id: "a", header: "Plan", question: "Ship now?" }, { id: "b", header: "Scope", question: "Tests too?" }] }),
    codexCommand: appRequestText("item/commandExecution/requestApproval", { command: "rm -rf build" }),
    acpPermission: appRequestText("session/request_permission", { toolCall: { toolCallId: "c", title: "Edit main.ts" } }),
    acpElicitation: appRequestText("elicitation/create", { message: "Pick one" }),
    unknownType: appRequestText("terminal/create", { command: "ls" }),
    missingField: appRequestText("item/tool/requestUserInput", { questions: [] }),
    blank: appRequestText("mcpServer/elicitation/request", { message: "  " }),
    noBody: appRequestText("elicitation", undefined),
  }).toEqual({
    claudeApproval: "Bash",
    codexElicitation: "Sign in?",
    codexQuestions: "Ship now?\nTests too?",
    codexCommand: "rm -rf build",
    acpPermission: "Edit main.ts",
    acpElicitation: "Pick one",
    unknownType: undefined,
    missingField: undefined,
    blank: undefined,
    noBody: undefined,
  });
});
