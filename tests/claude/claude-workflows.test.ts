/* oxlint-disable max-statements -- Follow the recorded native frames through the live adapter and its public folds. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { tasksOf } from "../../packages/oar/src/observe/tasks.js";
import { statusOf } from "../../packages/oar/src/observe/agent-status.js";
import { initialSessionView, reduceSessionView, viewOf } from "../../packages/oar/src/observe/session-view.js";
import { eventsOf } from "../../packages/oar/src/observe/events.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); vi.unstubAllEnvs(); });
const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.292" } as const;

// Lookout's Claude 2.1.292 + aimock recordings, 2026-10-10. No account;
// two phases, two agents, then variants with a child Bash call and TaskStop.
function recording(scenario: string) {
  return readFileSync(new URL(`../replay/fixtures/claude-${scenario}.raw.jsonl`, import.meta.url), "utf8")
    .trim().split("\n").map((line) => asRecord(parseJson(line))).filter((row) => row !== null);
}

const scenarios = [
  { name: "workflow", frames: 63, results: 2, input: 18_400, output: 315, childInput: 2500, childOutput: 70 },
  { name: "workflow-agent-tool", frames: 64, results: 2, input: 19_650, output: 325, childInput: 3750, childOutput: 80 },
  { name: "workflow-stopped", frames: 56, results: 1, input: 15_900, output: 240, childInput: 0, childOutput: 0 },
];

function assertWorkflowResult(session: Awaited<ReturnType<typeof claudeSession>>, scenario: typeof scenarios[number], frames: ReturnType<typeof recording>) {
  const records = session.records();
  const events = records.flatMap((record) => eventsOf(record));
  expect(events.filter((event) => event.kind === "turn_started")).toHaveLength(scenario.results); // Second request is the explicit busy probe.
  expect(events.filter((event) => event.kind === "turn_active")).toHaveLength(scenario.results - 1);
  expect(events.every((event) => event.agentPath.length === 0)).toBe(true);
  expect(events.filter((event) => event.kind === "tool_call_started").map((event) => event.tool))
    .toEqual(scenario.results === 1 ? ["Workflow", "TaskStop"] : ["Workflow"]);
  expect(events.flatMap((event) => event.kind === "task_updated" && event.description !== undefined ? [event.description] : []))
    .toEqual(scenario.results === 1 ? ["Gather: alpha"] : ["Gather: alpha", "Review: beta"]);
  const started = frames.find((message) => message.subtype === "task_started");
  const tasks = tasksOf(records).value;
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ taskId: started?.task_id, taskType: "workflow", nativeType: "local_workflow", toolCallId: started?.tool_use_id,
    description: scenario.results === 1 ? "Gather: alpha" : "Review: beta", status: scenario.results === 1 ? "stopped" : "completed" });
  expect(tasks[0]?.taskId).not.toBe(started?.run_id);
  expect(session.usage().value).toEqual({
    total: { input: scenario.input, output: scenario.output, cacheRead: 0, cacheWrite: 0 },
    ...(scenario.childInput === 0 ? {} : {
      byAgent: [{ agentPath: [], tokens: { input: scenario.input - scenario.childInput, output: scenario.output - scenario.childOutput, cacheRead: 0, cacheWrite: 0 } }],
      unattributed: { input: scenario.childInput, output: scenario.childOutput, cacheRead: 0, cacheWrite: 0 },
    }),
  });
}

test.each(scenarios)("$name: one workflow task, changed descriptions, native spend and spontaneous turns", async (scenario) => {
  const frames = recording(scenario.name);
  const child = fakeLineProcess();
  spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  let live = initialSessionView();
  session.rawEvents((record) => { live = reduceSessionView(live, record); });
  let turns = 0;
  let results = 0;
  const echo = frames.find((message) => message.isReplay === true);
  assert.ok(typeof echo?.uuid === "string");
  await session.prompt("RUN-WORKFLOW-FIXTURE: run the two-phase workflow.", { inputId: echo.uuid });
  try {
    for (const message of frames) {
      const before = session.usage().value;
      child.emit(`${JSON.stringify(message)}\n`);
      if (message.subtype === "init") {
        turns += 1;
        expect(session.status().value.kind).toBe("running");
        expect(live.messages.filter((item) => item.kind === "turn")).toHaveLength(turns);
        if (turns === 2) {
          // The probe must finish before the next native frame, especially its result.
          // oxlint-disable-next-line no-await-in-loop
          expect(await session.prompt("must be busy")).toMatchObject({ kind: "rejected", code: "busy" });
        }
      }
      if (message.subtype === "task_progress") { expect(session.usage().value).toEqual(before); }
      if (asRecord(message.patch)?.status === "killed") { expect(tasksOf(session.records()).value[0]?.status).toBe("stopped"); }
      if (message.type === "result") { results += 1; expect(session.status().value.kind).toBe("idle"); }
    }
    const records = session.records();
    const native = records.flatMap((record) => record.kind === "frame" ? [record.body.native] : []);
    expect(native).toEqual(frames);
    expect(native).toHaveLength(scenario.frames);
    expect(results).toBe(scenario.results);
    expect(turns).toBe(scenario.results);
    expect(live).toEqual(viewOf(records));
    expect(session.status()).toEqual(statusOf(records, session.id));
    assertWorkflowResult(session, scenario, frames);
  } finally { await session.dispose(); }
});

test("workflow_progress stays native, with nested credentials redacted", async () => {
  const secret = "workflow-progress-credential-sentinel";
  const child = fakeLineProcess();
  spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work", env: { ANTHROPIC_API_KEY: secret } });
  try {
    child.emit(`${JSON.stringify({ type: "system", subtype: "task_progress", task_id: "workflow", description: "Gather: alpha",
      workflow_progress: [{ type: "workflow_agent", lastToolName: "Bash", lastToolSummary: `echo ${secret}` }] })}\n`);
    const [record] = session.records();
    expect(record?.kind === "frame" ? record.body.events : null).toEqual([{ kind: "task_updated", taskId: "workflow", description: "Gather: alpha" }]);
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(record?.kind === "frame" ? record.body.native : null).toMatchObject({ workflow_progress: [{ type: "workflow_agent", lastToolName: "Bash", lastToolSummary: "echo [redacted]" }] });
  } finally { await session.dispose(); }
});
