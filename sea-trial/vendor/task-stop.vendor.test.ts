/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function, import/max-dependencies -- Native lifecycle proofs keep target, sibling and parent assertions in one bounded run. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import type { Session, Event } from "../../packages/oar/src/contracts/session.js";
import { claudeInstallation, claudeSession, codexInstallation, codexSession, eventsOf, promptAndWait } from "../../packages/oar/src/index.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock, startCodexAimock } from "../harness/aimock.js";
import { resolveRunDir } from "../harness/trace.js";
import { codexTaskIsResumed, codexTaskRecipient, codexTaskRequest } from "./support/codex-task-request.js";
import { codexTaskRootReply } from "./support/codex-task-script.js";

function taskEvents(session: Session): Event[] { return session.records().flatMap(record => eventsOf(record)).filter(e => e.kind.startsWith("task_")); }

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("Claude stops one native task; its sibling and the parent continue", async () => {
  let calls = 0;
  const provider = await startClaudeAimock(mock => {
    mock.on({ predicate: () => true }, () => {
      calls += 1;
      return calls === 1 ? { toolCalls: [
        { id: "task_a", name: "Bash", arguments: JSON.stringify({ command: 'node -e "setTimeout(() => console.log(\'TASK_A_FINISHED\'), 30000)"', description: "TASK_A", run_in_background: true }) },
        { id: "task_b", name: "Bash", arguments: JSON.stringify({ command: 'node -e "setTimeout(() => console.log(\'TASK_B_FINISHED\'), 4000)"', description: "TASK_B", run_in_background: true }) },
      ] } : { content: "PARENT_OK" };
    });
  });
  const installation = await claudeInstallation(); assert.ok(installation.kind === "available");
  let session: Session | undefined = undefined;
  try {
    session = await claudeSession(installation, { cwd: process.cwd(), env: { ...provider.env }, model: "haiku", userConfiguration: "exclude" });
    const current = session;
    expect(await current.prompt("Start the two test tasks.")).toMatchObject({ kind: "accepted" });
    await expect.poll(() => taskEvents(current).filter(e => e.kind === "task_started").length, { timeout: 30_000 }).toBe(2);
    const target = taskEvents(current).find(e => e.kind === "task_started" && e.description === "TASK_A");
    const peer = taskEvents(current).find(e => e.kind === "task_started" && e.description === "TASK_B");
    assert.ok(target?.kind === "task_started" && peer?.kind === "task_started");
    expect(await current.stopTask?.(target.taskId)).toMatchObject({ kind: "accepted" });
    await expect.poll(() => taskEvents(current).find(e => e.kind === "task_ended" && e.taskId === target.taskId), { timeout: 30_000 }).toMatchObject({ status: "stopped" });
    await expect.poll(() => taskEvents(current).find(e => e.kind === "task_ended" && e.taskId === peer.taskId), { timeout: 30_000 }).toMatchObject({ status: "completed" });
    await expect.poll(() => current.status().value.kind, { timeout: 30_000 }).toBe("idle");
    expect(await promptAndWait(current, "Parent follow-up.")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    const before = taskEvents(current).length;
    expect(await current.stopTask?.("missing-task")).toMatchObject({ kind: "accepted" });
    expect(taskEvents(current)).toHaveLength(before);
  } finally { await session?.dispose(); await provider.stop(); }
}, 90_000);

function qualify(value: unknown): unknown {
  const item = asRecord(value);
  return item?.type === "function_call" && (item.name === "spawn_agent" || item.name === "followup_task") ? { ...item, namespace: "collaboration" } : value;
}
function qualifyResponse(body: string): string {
  return body.split("\n").map(line => {
    if (!line.startsWith("data: ")) { return line; }
    const event = asRecord(parseJson(line.slice(6))); if (event === null) { return line; }
    const response = asRecord(event.response);
    return `data: ${JSON.stringify({ ...event, ...("item" in event ? { item: qualify(event.item) } : {}), ...(Array.isArray(response?.output) ? { response: { ...response, output: response.output.map(value => qualify(value)) } } : {}) })}`;
  }).join("\n");
}
function childTurns(session: Session, id: string): JsonRecord[] {
  return session.records().flatMap(record => {
    if (record.kind !== "frame" || record.body.type !== "turn/completed" || record.sessionId !== id) { return []; }
    const turn = asRecord(asRecord(record.body.native)?.turn); return turn === null ? [] : [turn];
  });
}

test.skipIf(process.env.OAR_TEST !== "codex-aimock").each(["before", "during"])("Codex child interruption permits later work when the peer finishes %s the follow-up", async timing => {
  let rootCalls = 0; let targetCalls = 0; let followupReplies = 0;
  const finishPeer = Promise.withResolvers<void>();
  const peerObserved = Promise.withResolvers<void>();
  const provider = await startCodexAimock(mock => {
    mock.on({ predicate: () => true }, async request => {
      const recipient = codexTaskRecipient(request);
      if (recipient === "/root/a") { targetCalls += 1; await delay(codexTaskIsResumed(request) ? 250 : 15_000); return { content: "CHILD_A_DONE" }; }
      if (recipient === "/root/b") { await (timing === "during" ? finishPeer.promise : delay(4000)); return { content: "CHILD_B_DONE" }; }
      rootCalls += 1;
      const reply = codexTaskRootReply(request);
      if ("toolCalls" in reply && reply.toolCalls.some(call => call.id === "followup_a")) {
        followupReplies += 1;
        // Completion activity precedes native mailbox delivery. Holding this reply
        // overlaps the peer's completion, but does not guarantee a discarded proposal.
        if (timing === "during") { finishPeer.resolve(); await peerObserved.promise; }
      }
      return reply;
    });
  }, { captureRaw: true, rewriteResponse: qualifyResponse, rewriteRequest: codexTaskRequest });
  const installation = await codexInstallation(); assert.ok(installation.kind === "available");
  let session: Session | undefined = undefined;
  try {
    session = await codexSession(installation, { cwd: process.cwd(), env: { ...provider.env }, model: "gpt-6.1-sol", launchArgs: ["-c", "features.multi_agent=true", "-c", "features.multi_agent_v2=true"] });
    const current = session;
    expect(await current.prompt("TASK_ROOT")).toMatchObject({ kind: "accepted" });
    await expect.poll(() => taskEvents(current).filter(e => e.kind === "task_started").length, { timeout: 30_000 }).toBe(2);
    const target = taskEvents(current).find(e => e.kind === "task_started" && e.description === "/root/a");
    const peer = taskEvents(current).find(e => e.kind === "task_started" && e.description === "/root/b");
    assert.ok(target?.kind === "task_started" && peer?.kind === "task_started");
    current.events(event => { if (event.kind === "task_ended" && event.taskId === peer.taskId) { peerObserved.resolve(); } });
    await expect.poll(() => current.records().some(r => r.kind === "frame" && r.sessionId === target.taskId && r.body.type === "turn/started"), { timeout: 30_000 }).toBe(true);
    // Native turn start can precede the first model request, including on Windows.
    await expect.poll(() => targetCalls, { timeout: 30_000 }).toBe(1);
    expect(await current.stopTask?.(target.taskId)).toMatchObject({ kind: "accepted" });
    await expect.poll(() => childTurns(current, target.taskId)[0]?.status, { timeout: 30_000 }).toBe("interrupted");
    expect(taskEvents(current).filter(e => e.kind === "task_ended" && e.taskId === target.taskId)).toEqual([]);
    if (timing === "before") { await expect.poll(() => taskEvents(current).find(e => e.kind === "task_ended" && e.taskId === peer.taskId), { timeout: 30_000 }).toMatchObject({ status: "completed" }); }
    await expect.poll(() => current.status().value.kind, { timeout: 30_000 }).toBe("idle");
    const beforeFollowup = current.records().at(-1)?.seq; assert.ok(beforeFollowup !== undefined);
    expect(await promptAndWait(current, "PARENT_FOLLOWUP")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    await expect.poll(() => childTurns(current, peer.taskId)[0]?.status, { timeout: 30_000 }).toBe("completed");
    await expect.poll(() => childTurns(current, target.taskId)[1]?.status, { timeout: 30_000 }).toBe("completed");
    await expect.poll(() => taskEvents(current).find(e => e.kind === "task_ended" && e.taskId === target.taskId), { timeout: 30_000 }).toMatchObject({ status: "completed" });
    expect(targetCalls).toBe(2);
    expect(childTurns(current, target.taskId)[1]?.id).not.toBe(childTurns(current, target.taskId)[0]?.id);
    const followupActivity = current.records().filter(record => record.kind === "frame" && record.body.type === "item/completed" && asRecord(asRecord(record.body.native)?.item)?.id === "followup_a");
    expect(followupActivity).toHaveLength(1);
    const followupStart = current.records().find(record => record.seq > beforeFollowup && record.sessionId === current.id && record.kind === "frame" && record.body.type === "turn/started");
    const peerEnd = taskEvents(current).find(e => e.kind === "task_ended" && e.taskId === peer.taskId);
    assert.ok(followupStart !== undefined && peerEnd?.kind === "task_ended" && followupActivity[0] !== undefined);
    expect(peerEnd.status).toBe("completed");
    if (timing === "during") {
      expect(peerEnd.seq).toBeGreaterThan(followupStart.seq);
      expect(peerEnd.seq).toBeLessThan(followupActivity[0].seq);
    } else { expect(peerEnd.seq).toBeLessThan(followupStart.seq); }
  } finally {
    finishPeer.resolve(); peerObserved.resolve();
    try { await session?.dispose(); }
    finally {
      try { await writeFile(path.join(resolveRunDir(), `codex-task-stop-${timing}.json`), JSON.stringify({ rootCalls, targetCalls, followupReplies, requests: provider.raw, records: session?.records() }, null, 2)); }
      finally { await provider.stop(); }
    }
  }
}, 90_000);

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("Claude single stop also targets a foreground Agent while its sibling completes", async () => {
  let rootCalls = 0;
  const provider = await startClaudeAimock(mock => {
    mock.on({ predicate: () => true }, async request => {
      const user = JSON.stringify(request.messages.findLast(message => message.role === "user"));
      if (user.includes("FOREGROUND_CHILD_A")) { await delay(10_000); return { content: "A_DONE" }; }
      if (user.includes("FOREGROUND_CHILD_B")) { await delay(1000); return { content: "B_DONE" }; }
      rootCalls += 1;
      return rootCalls === 1 ? { toolCalls: [
        { id: "agent_a", name: "Agent", arguments: JSON.stringify({ prompt: "FOREGROUND_CHILD_A", description: "FOREGROUND_A", subagent_type: "general-purpose", run_in_background: false }) },
        { id: "agent_b", name: "Agent", arguments: JSON.stringify({ prompt: "FOREGROUND_CHILD_B", description: "FOREGROUND_B", subagent_type: "general-purpose", run_in_background: false }) },
      ] } : { content: "PARENT_OK" };
    });
  });
  const installation = await claudeInstallation(); assert.ok(installation.kind === "available");
  let session: Session | undefined = undefined;
  try {
    session = await claudeSession(installation, { cwd: process.cwd(), env: { ...provider.env }, model: "haiku", userConfiguration: "exclude" });
    const current = session;
    expect(await current.prompt("Start the foreground agents.")).toMatchObject({ kind: "accepted" });
    await expect.poll(() => taskEvents(current).filter(e => e.kind === "task_started").length, { timeout: 30_000 }).toBe(2);
    const target = taskEvents(current).find(e => e.kind === "task_started" && e.description === "FOREGROUND_A");
    const peer = taskEvents(current).find(e => e.kind === "task_started" && e.description === "FOREGROUND_B");
    assert.ok(target?.kind === "task_started" && peer?.kind === "task_started");
    expect(target.taskType).toBe("agent");
    expect(await current.stopTask?.(target.taskId)).toMatchObject({ kind: "accepted" });
    await expect.poll(() => taskEvents(current).find(e => e.kind === "task_ended" && e.taskId === target.taskId), { timeout: 30_000 }).toMatchObject({ status: "stopped" });
    await expect.poll(() => taskEvents(current).find(e => e.kind === "task_ended" && e.taskId === peer.taskId), { timeout: 30_000 }).toMatchObject({ status: "completed" });
    await expect.poll(() => current.status().value.kind, { timeout: 30_000 }).toBe("idle");
    expect(await promptAndWait(current, "Follow up.")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
  } finally { await session?.dispose(); await provider.stop(); }
}, 90_000);
