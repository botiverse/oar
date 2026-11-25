import { afterEach, expect, test, vi } from "vitest";
import { appRequestText, eventsOf } from "../../packages/oar/src/observe/index.js";
import { viewOf } from "../../packages/oar/src/observe/session-view.js";
import { claudeAppRequestResponse, claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });

type OpenedSession = Awaited<ReturnType<typeof claudeSession>>;

async function openSession(): Promise<{ readonly child: FakeLineProcess; readonly session: OpenedSession }> {
  const child = fakeLineProcess();
  spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession({ kind: "available", via: "executable", command: "claude", version: "2.1.332" }, { cwd: "/work" });
  await session.prompt("Call the ask tool");
  return { child, session };
}

function elicitationFrame(requestId: string, mode: "form" | "url") {
  const request = mode === "form"
    ? { subtype: "elicitation", mcp_server_name: "ask", message: "Which color do you like?", mode: "form", requested_schema: { type: "object" } }
    : { subtype: "elicitation", mcp_server_name: "auth", message: "Open URL to sign in", mode: "url", url: "https://example.invalid/oauth", elicitation_id: "e-url-1" };
  return { type: "control_request", request_id: requestId, request };
}

function requestParts(session: OpenedSession) {
  return viewOf(session.records()).messages.flatMap((message) => message.kind === "turn"
    ? message.sections.flatMap((section) => section.parts.filter((part) => part.kind === "app_request"))
    : []);
}

function appEvents(session: OpenedSession) {
  return session.records().flatMap((record) => eventsOf(record)).filter((event) => event.kind.startsWith("app_"));
}

async function emitAndSettle(child: FakeLineProcess, frame: Record<string, unknown>) {
  const before = [...child.written];
  child.emit(`${JSON.stringify(frame)}\n`);
  await Promise.resolve();
  return before;
}

function assertDeclined(session: OpenedSession, frame: ReturnType<typeof elicitationFrame>, expectedReply: Record<string, unknown>) {
  const requestId = frame.request_id;
  expect(appEvents(session)).toMatchObject([{ kind: "app_request", requestId, type: "elicitation" }, { kind: "app_answered", requestId }]);
  expect(session.records().filter((record) => record.kind === "response" && record.requestId === requestId)).toMatchObject([{ body: { kind: "answered", native: expectedReply } }]);
  expect(viewOf(session.records()).pendingRequests).toEqual([]);
  const [part] = requestParts(session);
  expect(part).toMatchObject({ kind: "app_request", requestId, type: "elicitation", answered: true });
  expect(part?.kind === "app_request" ? appRequestText(part.type, part.body) : undefined).toBe(frame.request.message);
}

test.each(["form", "url"] as const)("Claude automatically declines %s MCP elicitation and records answered", async (mode) => {
  const { child, session } = await openSession();
  const requestId = `elicit-${mode}-1`;
  const frame = elicitationFrame(requestId, mode);
  const expectedReply = { type: "control_response", response: { subtype: "success", request_id: requestId, response: { action: "decline" } } };
  try {
    const before = await emitAndSettle(child, frame);
    expect(child.written.slice(before.length)).toEqual([`${JSON.stringify(expectedReply)}\n`]);
    assertDeclined(session, frame, expectedReply);
  } finally { await session.dispose(); }
});

test("Claude leaves non-elicitation control requests such as request_user_dialog recorded and unanswered", async () => {
  const { child, session } = await openSession();
  const dialog = { type: "control_request", request_id: "dialog-1", request: { subtype: "request_user_dialog", message: "Choose" } };
  try {
    const before = await emitAndSettle(child, dialog);
    expect(child.written).toEqual(before);
    expect(appEvents(session)).toMatchObject([{ kind: "app_request", requestId: "dialog-1", type: "request_user_dialog" }]);
    expect(viewOf(session.records()).pendingRequests).toMatchObject([{ requestId: "dialog-1", type: "request_user_dialog", body: dialog }]);
    expect(requestParts(session)).toMatchObject([{ kind: "app_request", requestId: "dialog-1", answered: false }]);
  } finally { await session.dispose(); }
});

test("claudeAppRequestResponse declines only exact elicitation subtype", () => {
  expect(claudeAppRequestResponse("elicitation", "req-1")).toEqual({
    type: "control_response",
    response: { subtype: "success", request_id: "req-1", response: { action: "decline" } },
  });
  for (const other of ["can_use_tool", "request_user_dialog", "toString", "constructor", "__proto__"]) {
    expect(claudeAppRequestResponse(other, "req-2")).toBeNull();
  }
});
