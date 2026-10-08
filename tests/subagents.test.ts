import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { formatReport, reportOrigin, SUBAGENT_DEPTH_ENV, type Subagents } from "../packages/oar/src/agents/index.js";
import type { Session } from "../packages/oar/src/contracts/session.js";
import { conversationOf } from "../packages/oar/src/observe/conversation.js";
import { scriptedRuntime } from "../packages/oar/src/testing/index.js";
import { crewOf, echo, Gate, spawned } from "./fixtures/subagent-fixtures.js";

const previousDepth = process.env[SUBAGENT_DEPTH_ENV];
afterEach(() => {
  if (previousDepth === undefined) {
    delete process.env[SUBAGENT_DEPTH_ENV];
  } else {
    process.env[SUBAGENT_DEPTH_ENV] = previousDepth;
  }
});

test("a spawned subagent's finished turn is a report with its text, read once by wait", async () => {
  const crew = crewOf(echo);
  await spawned(crew, "count files", "counter");
  const [report] = await crew.wait({ timeoutMs: 5000 });
  expect(report).toMatchObject({ id: "counter", name: "counter", runtime: "fake", turn: 1, outcome: { kind: "completed" }, text: "did: count files" });
  expect(await crew.wait({ timeoutMs: 0 })).toEqual([]);
  expect(crew.list()).toMatchObject([{ id: "counter", state: "idle", turns: 1 }]);
  expect(crew.tasks()).toMatchObject([{ taskId: "counter", taskType: "agent", status: "completed", summary: "did: count files", background: true }]);
  await crew.close();
});

test("a follow-up steers a running subagent", async () => {
  const gate = new Gate();
  const crew = crewOf(gate.script);
  const agent = await spawned(crew, "first");
  expect(await agent.send("hurry")).toEqual({ kind: "accepted", landed: "steered" });
  gate.release();
  const reports = await crew.wait({ timeoutMs: 5000 });
  expect(reports.map((report) => report.text)).toEqual(["working on first steered: hurry"]);
  await crew.close();
});

test("a follow-up starts a new turn on an idle subagent", async () => {
  const crew = crewOf(echo);
  const agent = await spawned(crew, "first");
  await crew.wait({ timeoutMs: 5000 });
  expect(await agent.send("second")).toEqual({ kind: "accepted", landed: "prompted" });
  const reports = await crew.wait({ timeoutMs: 5000 });
  expect(reports).toMatchObject([{ id: "fake-1", turn: 2, text: "did: second" }]);
  await crew.close();
});

test("children run one level deeper than their host", async () => {
  const depths: (string | null | undefined)[] = [];
  const crew = crewOf((turn) => {
    depths.push(turn.options.env?.[SUBAGENT_DEPTH_ENV]);
  });
  await spawned(crew, "a");
  await expect.poll(() => depths, { timeout: 5000 }).toEqual(["1"]);
  process.env[SUBAGENT_DEPTH_ENV] = "1";
  expect(await crew.spawn({ runtime: "fake", task: "b" })).toMatchObject({ kind: "refused", code: "depth_limit" });
  await crew.close();
});

test("the running limit and unknown runtimes refuse with a reason", async () => {
  const gate = new Gate();
  const crew = crewOf(gate.script, { maxRunning: 1 });
  await spawned(crew, "a");
  expect(await crew.spawn({ runtime: "fake", task: "b" })).toMatchObject({ kind: "refused", code: "running_limit" });
  expect(await crew.spawn({ runtime: "nope", task: "c" })).toMatchObject({ kind: "refused", code: "unknown_runtime" });
  gate.release();
  await crew.close();
});

async function recordingParent(inputs: string[]): Promise<Session> {
  const session = await scriptedRuntime({ id: "parent", turn: (turn) => {
    inputs.push(turn.input);
  } }).session({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  return session;
}

test("an onReport hook delivering into an idle parent wakes it with a turn of its own", async () => {
  const inputs: string[] = [];
  const parent = await recordingParent(inputs);
  const crew = crewOf(echo);
  crew.onReport((report) => {
    void parent.deliver(formatReport(report), { origin: reportOrigin(report) });
  });
  await spawned(crew, "summarize", "helper");
  await expect.poll(() => inputs.length, { timeout: 5000 }).toBe(1);
  expect(inputs[0]).toMatch(/^\[subagent helper on fake, turn 1: completed; session [^\]]+\]\ndid: summarize$/u);
  expect(crew.unread()).toEqual([]);
  expect([...conversationOf(parent.records()).inputs.values()].map((input) => input.origin)).toEqual([{ kind: "notification", source: "subagent:helper" }]);
  await Promise.all([crew.close(), parent.dispose()]);
});

test("a report every hook throws on stays unread", async () => {
  const crew = crewOf(echo);
  crew.onReport(() => {
    throw new Error("app inbox down");
  });
  await spawned(crew, "x");
  await expect.poll(() => crew.unread().length, { timeout: 5000 }).toBe(1);
  await crew.close();
});

async function closeMidTurn(dir: string): Promise<Subagents> {
  const gate = new Gate();
  const crew = crewOf(gate.script, { logDir: dir });
  await spawned(crew, "long job");
  await expect.poll(() => gate.started, { timeout: 5000 }).toBe(1);
  await crew.close();
  return crew;
}

test("closing a running subagent ends its task stopped, and its log keeps its records", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-subagents-"));
  try {
    const crew = await closeMidTurn(dir);
    expect(crew.tasks()).toMatchObject([{ taskId: "fake-1", status: "stopped" }]);
    const [file] = readdirSync(dir);
    const lines = readFileSync(path.join(dir, file ?? ""), "utf8").trim().split("\n");
    expect(lines[0]).toContain('"kind":"header"');
    expect(lines.some((line) => line.includes("long job"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wait returns nothing when no report arrives before its timeout", async () => {
  const gate = new Gate();
  const crew = crewOf(gate.script);
  await spawned(crew, "slow");
  const started = Date.now();
  expect(await crew.wait({ timeoutMs: 200 })).toEqual([]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  gate.release();
  await crew.close();
});
