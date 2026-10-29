import { expect, test, vi } from "vitest";
import { createSubagent } from "../packages/oar/src/agents/subagent.js";
import { createSessionKernel, sealSession } from "../packages/oar/src/kernel.js";

function fixture() {
  const kernel = createSessionKernel("shared-session");
  kernel.opened({ requested: "auto", placement: "shared" });
  const dispose = vi.fn(async () => {
    await kernel.control({ kind: "dispose" }, () => ({ kind: "accepted" }));
  });
  const session = sealSession({
    id: kernel.sessionId, capabilities: { queue: { durable: false }, images: false, attribution: "none" },
    prompt: async (input, options) => kernel.control({ kind: "prompt", input, ...options }, () => ({ kind: "accepted" })),
    queue: async (input, options) => kernel.control({ kind: "queue", input, ...options }, () => ({ kind: "accepted" })),
    withdraw: async (inputId) => kernel.control({ kind: "withdraw", inputId }, () => ({ kind: "accepted" })),
    abort: async () => {
      const result = await kernel.control({ kind: "abort" }, () => ({ kind: "accepted" }));
      kernel.respond(result.request.id, { kind: "released", reason: "abort_fallback", nativeTurnMayContinue: true, workStartedAfterCleanupMayContinue: true });
      return result;
    },
    dispose, records: () => kernel.records(), rawEvents: (...args) => kernel.rawEvents(...args), graph: () => kernel.graph(),
  });
  return { kernel, session, dispose };
}

// oxlint-disable-next-line max-statements -- Follow the report, task, late frame and final cleanup of a released subagent.
test("a released subagent reports aborted once, closes, and retains late native evidence only in its log", async () => {
  const { kernel, session, dispose } = fixture();
  const hooks = { report: vi.fn(), task: vi.fn(), mayRun: () => true, closed: vi.fn() };
  const agent = createSubagent({ id: "one", runtime: "mock" }, session, hooks);
  await agent.send("work");
  const waiting = agent.nextReport();
  await agent.interrupt();
  await expect(waiting).resolves.toMatchObject({ outcome: { kind: "aborted" }, turn: 1 });
  expect(agent.info().state).toBe("closed");
  expect(hooks.task).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "task_ended", status: "stopped" }));
  kernel.frame({ type: "late", native: {}, events: [{ kind: "text_delta", text: "late" }, { kind: "turn_ended", outcome: { kind: "completed" } }] });
  expect(hooks.report).toHaveBeenCalledTimes(1);
  expect(session.records().at(-1)).toMatchObject({ kind: "frame", body: { type: "late" } });
  await expect(agent.send("again")).resolves.toMatchObject({ kind: "rejected", code: "closed" });
  await agent.close();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(hooks.closed).toHaveBeenCalledTimes(1);
});

test("interrupt delivery reports session release and preserves the undelivered input identity", async () => {
  const { session, dispose } = fixture();
  await session.prompt("work");
  const inputId = crypto.randomUUID();
  const result = await session.deliver("followup", { when: "interrupt", maxWaitMs: 0, inputId });
  expect(result).toMatchObject({ landed: "rejected", code: "session_released", inputId, undeliveredInputIds: [inputId] });
  expect(session.records().filter((record) => record.kind === "request" && record.body.kind === "prompt")).toHaveLength(1);
  await dispose();
});
