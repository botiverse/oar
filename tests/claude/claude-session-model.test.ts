import { afterEach, expect, test, vi } from "vitest";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.261" } as const;

afterEach(() => {
  spawnLineProcess.mockReset();
});

function frame(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

// claude says nothing about the model until a turn starts; the read-back is
// the `model` of the system/init frame (claude 2.1.261), so a requested model
// the CLI silently replaced shows up as the replacement, not the request.
test("Session.model is null until claude's system/init frame and then reports its model", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: "/work", model: "requested-y" });
  expect(spawnLineProcess.mock.calls[0]?.[1]).toContain("requested-y");
  expect(session.model().value).toBeNull();

  fake.emit(frame({ type: "system", subtype: "init", session_id: session.id, model: "claude-x-real", tools: [] }));
  expect(session.model().value).toBe("claude-x-real");
  await session.dispose();
});

test("Session.model follows a later system/init frame", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: "/work" });
  fake.emit(frame({ type: "system", subtype: "init", session_id: session.id, model: "claude-x-real", tools: [] }));
  fake.emit(frame({ type: "system", subtype: "init", session_id: session.id, model: "claude-z-later", tools: [] }));
  expect(session.model().value).toBe("claude-z-later");
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- Keep the interleaved parent, sibling and nested frames in wire order.
test("child assistant models change independently for each path and leave the root model alone", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: "/work" });
  const assistant = (parent: string | null, model?: string, content: object[] = []): void => {
    fake.emit(frame({ type: "assistant", parent_tool_use_id: parent, message: { role: "assistant", model, content } }));
  };
  try {
    assistant(null, "unconfirmed-root");
    assistant("first", undefined);
    assistant("first", "small", [{ type: "tool_use", id: "nested", name: "Task", input: {} }]);
    expect(session.model().value).toBeNull();
    fake.emit(frame({ type: "system", subtype: "init", model: "root", tools: [] }));
    assistant("first", "small");
    assistant("second", "small");
    assistant("nested", "small");
    assistant("first", "<synthetic>");
    assistant("first", "large");
    assistant("second", "small");
    expect(session.records().flatMap(record => record.kind === "frame"
      ? record.body.events.flatMap(event => event.kind === "model" ? [[record.agentPath, event.model]] : []) : [])).toEqual([
      [["first"], "small"], [[], "root"], [["second"], "small"], [["first", "nested"], "small"], [["first"], "large"],
    ]);
    expect(session.model().value).toBe("root");
  } finally { await session.dispose(); }
});
