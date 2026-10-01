import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { createSubagents } from "../packages/oar/src/agents/index.js";
import type { Runtime } from "../packages/oar/src/contracts/runtime.js";
import { scriptedRuntime } from "../packages/oar/src/testing/index.js";
import { crewOf, echo, Gate, registryOf, silentOnDispose, spawned } from "./fixtures/subagent-fixtures.js";

function silentCrew(gate: Gate): ReturnType<typeof createSubagents> {
  const runtime = silentOnDispose(scriptedRuntime({ id: "fake", turn: gate.script }));
  return createSubagents({ runtimes: registryOf(runtime) });
}

test("closing mid-turn on a runtime that reports no end still yields an aborted report", async () => {
  const gate = new Gate();
  const crew = silentCrew(gate);
  const agent = await spawned(crew, "long job");
  await expect.poll(() => gate.started, { timeout: 5000 }).toBe(1);
  const pending = agent.nextReport();
  await crew.close();
  expect(await pending).toMatchObject({ turn: 1, outcome: { kind: "aborted" } });
  expect(crew.unread()).toMatchObject([{ id: "fake-1", outcome: { kind: "aborted" } }]);
  expect(crew.tasks()).toMatchObject([{ taskId: "fake-1", status: "stopped" }]);
  expect(await agent.nextReport()).toBeNull();
});

test("a next() waiting on a subagent keeps its report from waits that name no ids", async () => {
  const gate = new Gate();
  const crew = crewOf(gate.script);
  const agent = await spawned(crew, "mine");
  // The other wait registers first, so it would be first to look.
  const other = crew.wait({ timeoutMs: 300 });
  const mine = crew.next(agent.id);
  gate.release();
  expect(await other).toEqual([]);
  expect(await mine).toMatchObject({ id: agent.id, turn: 1 });
  await crew.close();
});

test("a next() cancelled by its signal leaves the report unread", async () => {
  const gate = new Gate();
  const crew = crewOf(gate.script);
  const agent = await spawned(crew, "cancel me");
  const controller = new AbortController();
  const waiting = crew.next(agent.id, { signal: controller.signal });
  controller.abort();
  expect(await waiting).toBeNull();
  gate.release();
  await expect.poll(() => crew.unread().length, { timeout: 5000 }).toBe(1);
  await crew.close();
});

function slowToProbe(runtime: Runtime): Runtime {
  return {
    ...runtime,
    installation: async () => {
      await delay(50);
      const installation = await runtime.installation?.();
      return installation ?? { kind: "not_found" };
    },
  };
}

test("a spawn in flight when the crew closes is refused and leaves no child", async () => {
  const runtime = slowToProbe(scriptedRuntime({ id: "fake", turn: echo }));
  const crew = createSubagents({ runtimes: registryOf(runtime) });
  const pending = crew.spawn({ runtime: "fake", task: "late" });
  await crew.close();
  expect(await pending).toMatchObject({ kind: "refused", code: "closed" });
  expect(crew.list()).toEqual([]);
  expect(await crew.spawn({ runtime: "fake", task: "after" })).toMatchObject({ kind: "refused", code: "closed" });
});

test("queueing on an idle subagent counts against the running limit", async () => {
  const gate = new Gate();
  const crew = crewOf(gate.script, { maxRunning: 1 });
  const first = await spawned(crew, "one");
  gate.release();
  await crew.wait({ timeoutMs: 5000 });
  await spawned(crew, "two");
  expect(await first.send("again", "queue")).toMatchObject({ kind: "rejected", code: "running_limit" });
  expect(await first.send("again")).toMatchObject({ kind: "rejected", code: "running_limit" });
  gate.release();
  await crew.close();
});

test("log names keep a chosen name inside the log directory", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-subagent-logs-"));
  try {
    const crew = crewOf(echo, { logDir: path.join(dir, "logs") });
    await spawned(crew, "x", "../frontend/api");
    await crew.wait({ timeoutMs: 5000 });
    await crew.close();
    const [file] = readdirSync(path.join(dir, "logs"));
    expect(file).toMatch(/^\.\._frontend_api-[\w-]+\.jsonl$/u);
    expect(existsSync(path.join(dir, "frontend"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
