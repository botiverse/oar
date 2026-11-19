import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { awaitTurnEnd, tasksOf, type Session } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { resolveRunDir } from "../harness/trace.js";
import { dshEnabled, eventsOf, nativeShell, posix, say, untilCount, withDshFixture } from "./support/dsh-fixture.js";
import { lastInput, toolResults } from "./support/dsh-provider.js";

const rootEnds = (session: Session): number => eventsOf(session.records(), session.id).filter(event => event.kind === "turn_ended").length;
const gate = "release-shell";
const heldCommand = posix
  ? `while [ ! -f '${gate}' ]; do sleep 0.02; done; printf 'BACKGROUND_DONE\\n'`
  : `while (-not (Test-Path -LiteralPath '${gate}')) { Start-Sleep -Milliseconds 20 }; Write-Output 'BACKGROUND_DONE'`;

// oxlint-disable-next-line eslint/max-lines-per-function -- Observe both root boundaries of one real background job.
test.skipIf(!dshEnabled)("DSH's background shell survives the first root end, settles, and wakes an audited tool turn", async () => {
  let wakeTool = false;
  await withDshFixture(request => {
    const input = lastInput(request);
    if (input.includes("BACKGROUND_ROOT") && toolResults(request) === 0) {
      return { kind: "tool", name: nativeShell.tool, arguments: { command: heldCommand, description: "held shell", run_in_background: true } };
    }
    if (!input.includes("BACKGROUND_ROOT") && !wakeTool) {
      wakeTool = true;
      return { kind: "tool", name: nativeShell.tool, arguments: nativeShell.where };
    }
    return say(wakeTool ? "wake finished" : "root finished");
  }, async ({ open, aimock, provider }) => {
    const session = await open();
    try {
      const started = await session.prompt("BACKGROUND_ROOT", { inputId: "00000000-0000-4000-8000-000000000197" });
      expect(await awaitTurnEnd(session, started.seq)).toEqual({ kind: "completed" });
      expect(session.status().value.kind).toBe("idle");
      const task = tasksOf(session.records()).value.find(row => row.taskType === "shell");
      assert.ok(task !== undefined);
      expect(task).toMatchObject({ status: "running", nativeType: nativeShell.tool, toolCallId: "call-1", sessionId: session.id });
      expect(task.background).toBeUndefined();
      expect(rootEnds(session)).toBe(1);
      await writeFile(path.join(aimock.cwd, gate), "release");
      await untilCount(() => rootEnds(session), 2);
      expect(rootEnds(session)).toBe(2);
      expect(tasksOf(session.records()).value.find(row => row.taskId === task.taskId)).toMatchObject({ status: "completed" });
      expect(wakeTool).toBe(true);
      expect(eventsOf(session.records(), session.id).filter(event => event.kind === "tool_call_ended")).toMatchObject([{ result: "ok" }, { result: "ok" }]);
      expect(session.records().filter(record => record.kind === "request" && record.body.kind === "prompt")).toHaveLength(1);
      const active = eventsOf(session.records(), session.id).filter(event => event.kind === "turn_active");
      expect(active).toHaveLength(2);
      expect(active[0]).toEqual({ kind: "turn_active", inputId: "00000000-0000-4000-8000-000000000197" });
      expect(active[1]?.inputId).toBeTypeOf("string");
      expect(active[1]?.inputId).not.toBe("00000000-0000-4000-8000-000000000197");
      const notice = session.records().find(record => record.kind === "frame" && record.body.type === "session/event:user/message" && asRecord(asRecord(asRecord(record.body.native)?.data)?.source)?.kind === "tool-jobs");
      expect(notice).toBeDefined();
      expect(session.status().value.kind).toBe("idle");
    } finally {
      await writeFile(path.join(resolveRunDir(), "dsh-background-shell.json"), JSON.stringify({ records: session.records(), requests: provider.requests }, null, 2));
      await writeFile(path.join(aimock.cwd, gate), "release");
      await session.dispose();
    }
  });
}, 60_000);

test.skipIf(!dshEnabled)("DSH stops only the selected session's shell job and records its native settlement", async () => {
  await withDshFixture(request => lastInput(request).includes("HOLD_SHELL") && toolResults(request) === 0
    ? { kind: "tool", name: nativeShell.tool, arguments: { command: heldCommand, description: "held shell", run_in_background: true } }
    : say("ok"), async ({ open, aimock }) => {
    const source = await open();
    const peer = await open();
    try {
      const admitted = await source.prompt("HOLD_SHELL");
      expect(await awaitTurnEnd(source, admitted.seq)).toEqual({ kind: "completed" });
      const job = tasksOf(source.records()).value.find(row => row.taskType === "shell");
      assert.ok(job !== undefined && source.stopTask !== undefined && peer.stopTask !== undefined);
      expect(await peer.stopTask(job.taskId)).toMatchObject({ kind: "rejected" });
      expect(tasksOf(source.records()).value.find(row => row.taskId === job.taskId)?.status).toBe("running");
      expect(await source.stopTask(job.taskId)).toMatchObject({ kind: "accepted" });
      expect(tasksOf(source.records()).value.find(row => row.taskId === job.taskId)?.status).toBe("stopped");
      expect(await source.stopTask(job.taskId)).toMatchObject({ kind: "rejected" });
    } finally {
      await writeFile(path.join(aimock.cwd, gate), "release");
    }
  });
}, 60_000);

test.skipIf(!dshEnabled)("DSH leaves a registered foreground shell running when asked to stop a task", async () => {
  await withDshFixture(request => toolResults(request) === 0
    ? { kind: "tool", name: nativeShell.tool, arguments: { command: heldCommand, description: "foreground shell" } }
    : say("ok"), async ({ open, aimock }) => {
    const session = await open();
    const reply = await session.prompt("foreground");
    try {
      const running = () => tasksOf(session.records()).value.find(row => row.taskType === "shell" && row.status === "running");
      await expect.poll(running, { timeout: 15_000 }).toBeDefined();
      const job = running();
      assert.ok(job !== undefined && session.stopTask !== undefined);
      expect(await session.stopTask(job.taskId)).toMatchObject({ kind: "rejected", code: "unsupported" });
      expect(running()?.taskId).toBe(job.taskId);
    } finally { await writeFile(path.join(aimock.cwd, gate), "release"); }
    expect(await awaitTurnEnd(session, reply.seq)).toEqual({ kind: "completed" });
  });
}, 60_000);
