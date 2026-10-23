/* oxlint-disable eslint/max-statements -- One ordered protocol interleaving pins queue and abort ownership. */
import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { launchQwen } from "../../packages/oar/src/runtimes/qwen/launch.js";
import { qwenSession } from "../../packages/oar/src/runtimes/qwen/session.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

vi.mock("../../packages/oar/src/runtimes/qwen/launch.js", () => ({ launchQwen: vi.fn() }));

const installation = { kind: "available" as const, via: "executable" as const, command: "qwen", version: "0.26.0" };
const id = "11111111-1111-4111-8111-111111111111";

function checkPermissionReply(child: ReturnType<typeof fakeLineProcess>, session: Awaited<ReturnType<typeof qwenSession>>): void {
  const permissionId = "native-permission";
  child.emit(`${JSON.stringify({ type: "control_request", request_id: permissionId, request: {
    subtype: "can_use_tool", tool_name: "mcp__echo__echo", tool_use_id: "native-echo",
    input: { text: "native-probe" }, blocked_path: null,
  } })}\n`);
  expect(child.written.map((line) => asRecord(parseJson(line)))).toContainEqual({
    type: "control_response", response: { subtype: "success", request_id: permissionId,
      response: { behavior: "allow", updatedInput: { text: "native-probe" } } },
  });
  const request = session.records().find((record) => record.kind === "request" && record.direction === "toApp");
  expect(request?.body).toMatchObject({ type: "can_use_tool" });
}

test("a dialect without command_lifecycle drains once, withdraws held input, aborts and becomes usable again", async () => {
  const child = fakeLineProcess((line, process) => {
    const frame = asRecord(parseJson(line)); const request = asRecord(frame?.request);
    if (request?.subtype === "initialize" || request?.subtype === "interrupt") {
      process.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: frame?.request_id, response: request.subtype === "initialize" ? { session_id: id } : {} } })}\n`);
    }
  });
  vi.mocked(launchQwen).mockResolvedValue(child);
  child.stdin.on("finish", () => { child.end(0); });
  const [one, two, gone, three] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const session = await qwenSession(installation, { cwd: "/fixture", resume: id });
  if (session.withdraw === undefined) { throw new Error("Qwen queue must be withdrawable"); }
  const emit = (frame: unknown) => { child.emit(`${JSON.stringify(frame)}\n`); };
  const init = () => { emit({ type: "system", subtype: "init", session_id: id, model: "native-model" }); };
  const end = () => { emit({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 400, output_tokens: 8 } }); };
  try {
    await expect(session.prompt("one", { inputId: one })).resolves.toMatchObject({ response: { body: { kind: "accepted" } } });
    init();
    checkPermissionReply(child, session);
    await session.queue("two", { inputId: two });
    await session.queue("withdrawn", { inputId: gone });
    await expect(session.withdraw(gone)).resolves.toMatchObject({ response: { body: { kind: "accepted" } } });
    end(); // Drains two immediately, before its system/init.
    await expect(session.prompt("must reject")).resolves.toMatchObject({ response: { body: { kind: "rejected", code: "busy" } } });
    expect(child.written.filter((line) => asRecord(parseJson(line))?.type === "user")).toHaveLength(2);
    init();
    await expect(session.abort()).resolves.toMatchObject({ response: { body: { kind: "accepted" } } });
    end();
    await expect(session.prompt("three", { inputId: three })).resolves.toMatchObject({ response: { body: { kind: "accepted" } } });
    init(); end();
    await expect(session.abort()).resolves.toMatchObject({ response: { body: { kind: "rejected", code: "no_active_turn" } } });
    await expect(session.prompt("four")).resolves.toMatchObject({ response: { body: { kind: "accepted" } } });
    init(); end();
    expect(session.model().value).toBe("native-model");
    expect(session.usage().value.total).toBeNull();
    const ends = session.records().flatMap((record) => record.kind === "frame" ? record.body.events.filter((event) => event.kind === "turn_ended") : []);
    expect(ends).toHaveLength(4);
    expect(ends[1]).toMatchObject({ outcome: { kind: "aborted" } });
    expect(child.written.join("")).not.toContain("withdrawn");
    expect(Object.hasOwn(session, "steer")).toBe(false);
  } finally { await session.dispose(); vi.restoreAllMocks(); }
  expect(await child.exited).toBe(0);
  await expect(session.prompt("after dispose")).resolves.toMatchObject({ response: { body: { kind: "rejected" } } });
});

test("private initialization failure preserves the runtime error and releases the process", async () => {
  const child = fakeLineProcess((line, process) => {
    const frame = asRecord(parseJson(line));
    process.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: frame?.request_id, error: "native startup failure" } })}\n`);
  });
  vi.mocked(launchQwen).mockResolvedValue(child);
  try { await expect(qwenSession(installation, { cwd: "/fixture" })).rejects.toThrow("native startup failure"); }
  finally { vi.restoreAllMocks(); }
  expect(child.killed()).toBe(true);
});
