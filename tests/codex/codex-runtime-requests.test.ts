import { expect, test, vi } from "vitest";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { codexRequestReply } from "../../packages/oar/src/runtimes/codex/runtime-requests.js";
import { eventsOf } from "../../packages/oar/src/observe/events.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "codex" } as const;

test.each([
  ["item/commandExecution/requestApproval", { decision: "decline" }],
  ["item/fileChange/requestApproval", { decision: "decline" }],
  ["item/permissions/requestApproval", { permissions: {} }],
  ["item/tool/requestUserInput", { answers: {} }],
  ["mcpServer/elicitation/request", { action: "decline" }],
  ["applyPatchApproval", { decision: "denied" }],
  ["execCommandApproval", { decision: "denied" }],
])("%s gets its own native refusal", (method, result) => {
  expect(codexRequestReply(method)).toEqual({ result });
});

test("a dynamic tool call fails rather than succeeding empty", () => {
  expect(codexRequestReply("item/tool/call")).toMatchObject({ result: { success: false } });
});

test.each(["account/chatgptAuthTokens/refresh", "attestation/generate", "currentTime/read", "a/method/from/a/later/version", "toString", "constructor", "__proto__"])("%s is not a decision and gets method not found", (method) => {
  expect(codexRequestReply(method)).toMatchObject({ error: { code: -32_601 } });
});

/** An app-server that sends one numeric-id request after the open, and collects its replies. */
function askingServer(replies: JsonRecord[]): void {
  spawnLineProcess.mockReturnValue(fakeLineProcess((line, child) => {
    const message = asRecord(parseJson(line));
    if (message?.id === 7 && message.method === undefined) { replies.push(message); return; }
    if (message?.id === undefined) { return; }
    child.emit(`${JSON.stringify({ id: message.id, result: message.method === "thread/start" ? { thread: { id: "thread" } } : {} })}\n`);
    if (message.method === "thread/start") {
      child.emit(`${JSON.stringify({ id: 7, method: "mcpServer/elicitation/request", params: { threadId: "thread" } })}\n`);
    }
  }));
}

test("the reply carries codex's own numeric id, and the records read as asked then answered", async () => {
  const replies: JsonRecord[] = [];
  askingServer(replies);
  const session = await codexSession(installation, { cwd: "/work" });
  await vi.waitFor(() => { expect(replies).toHaveLength(1); });
  expect(replies[0]).toEqual({ id: 7, result: { action: "decline" } });
  expect(session.records().flatMap((record) => eventsOf(record)).map((event) => event.kind).filter((kind) => kind.startsWith("app_"))).toEqual(["app_request", "app_answered"]);
  await session.dispose();
});
