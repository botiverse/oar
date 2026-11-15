/* oxlint-disable max-statements -- Exercise transport and observer boundaries through the public session. */
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { conversationOf } from "../packages/oar/src/observe/conversation.js";
import { asRecord, parseJson } from "../packages/oar/src/shared/json.js";
import heldQueueSession from "./fixtures/held-queue-session.js";
import { inputIdOf, withdraw } from "./fixtures/withdraw.js";

test.each(["claude", "qoder", "qwen", "cursor"] as const)("%s orders reentrant queues by their recorded requests", async name => {
  const f = await heldQueueSession(name);
  try {
    const second: { value?: ReturnType<typeof f.session.queue> } = {};
    f.session.rawEvents(record => {
      if (record.kind === "request" && record.body.kind === "queue" && record.body.input === "first") { second.value = f.session.queue("second"); }
    });
    const first = await f.session.queue("first");
    await second.value;
    expect(f.written()).toEqual(["first"]);
    f.start(inputIdOf(first)); await f.end(inputIdOf(first));
    expect(f.written()).toEqual(["first", "second"]);
  } finally { await f.session.dispose(); }
});

test.each(["claude", "qoder", "qwen", "cursor"] as const)("%s does not send after a dispatch observer releases the session", async name => {
  const f = await heldQueueSession(name);
  const disposed: { value?: Promise<void> } = {};
  f.session.rawEvents(record => {
    if (record.kind === "request" && record.body.kind === "prompt" && record.body.carries !== undefined) { disposed.value = f.session.dispose(); }
  });
  try {
    const queued = await f.session.queue("never send");
    await disposed.value; await settle();
    expect(f.written()).toEqual([]);
    expect(f.session.status().value.kind).toBe("idle");
    const dispatch = f.session.records().find(record => record.kind === "request" && record.body.kind === "prompt");
    assert.ok(dispatch?.kind === "request");
    expect(f.session.records().filter(record => record.kind === "response" && record.requestId === dispatch.id)).toMatchObject([{ body: { kind: "rejected" } }]);
    expect(f.session.records().filter(record => record.kind === "response" && record.requestId === queued.request.id)).toHaveLength(1);
    expect(f.session.records().filter(record => record.kind === "frame" && record.body.events.some(event => event.kind === "input_dropped"))).toEqual([]);
  } finally { await f.session.dispose(); }
});

test.each(["claude", "qoder", "qwen"] as const)("%s stops a dispatch when its process exits in a request observer", async name => {
  const f = await heldQueueSession(name);
  assert.ok(f.child !== undefined);
  const { child } = f;
  f.session.rawEvents(record => {
    if (record.kind === "request" && record.body.kind === "prompt") { child.end(1); }
  });
  try {
    await f.session.queue("never send");
    expect(f.written()).toEqual([]);
    expect(f.session.status().value.kind).toBe("idle");
    expect(f.session.records().filter(record => record.kind === "response" && record.body.kind === "rejected")).toMatchObject([{ body: { code: "runtime_exited" } }]);
  } finally { await f.session.dispose(); }
});

test.each(["claude", "qoder", "qwen"] as const)("%s retains ownership after a thrown write, without retrying or inventing a native refusal", async name => {
  const f = await heldQueueSession(name);
  assert.ok(f.child !== undefined);
  try {
    const first = await f.session.prompt("active"); f.start(inputIdOf(first));
    const held = await f.session.queue("failed write");
    const next = await f.session.queue("next");
    const write = vi.spyOn(f.child, "write").mockImplementationOnce(() => { throw new Error("fixture closed pipe"); });
    await f.end(inputIdOf(first)); await settle();
    expect(write).toHaveBeenCalledTimes(1);
    expect(f.written()).toEqual(["active"]);
    expect(f.session.status().value.kind).toBe("running");
    const input = [...conversationOf(f.session.records()).inputs.values()].find(value => value.inputId === inputIdOf(held));
    expect(input?.attempts.map(attempt => attempt.state)).toEqual(["accepted", "rejected"]);
    expect(f.session.records().filter(record => record.kind === "frame" && record.body.events.some(event => event.kind === "input_dropped"))).toEqual([]);
    expect(await withdraw(f.session, inputIdOf(held))).toBe("accepted");
    expect(f.written()).toEqual(["active", "next"]);
    f.start(inputIdOf(next)); await f.end(inputIdOf(next));
    expect(f.session.status().value.kind).toBe("idle");
  } finally { vi.restoreAllMocks(); await f.session.dispose(); }
});

test.each(["claude", "qoder"] as const)("%s does not reclaim a synchronously refused queue on its late dispatch acceptance", async name => {
  const f = await heldQueueSession(name);
  assert.ok(f.child !== undefined);
  const { child, emit } = f;
  const write = child.write.bind(child);
  const submitted: { value?: ReturnType<typeof f.session.prompt> } = {};
  try {
    vi.spyOn(child, "write").mockImplementationOnce(text => {
      write(text);
      emit({ type: "command_lifecycle", command_uuid: asRecord(parseJson(text))?.uuid, state: "completed" });
    });
    f.session.rawEvents(record => {
      if (record.kind === "frame" && record.body.events.some(event => event.kind === "input_dropped")) {
        expect(f.session.status().value.kind).toBe("idle");
        submitted.value = f.session.prompt("after refusal");
      }
    });
    const queued = await f.session.queue("duplicate");
    expect(await submitted.value).toMatchObject({ kind: "accepted" });
    expect([...conversationOf(f.session.records()).inputs.values()].find(value => value.inputId === inputIdOf(queued))?.state).toBe("dropped");
    const next = await submitted.value; assert.ok(next !== undefined);
    expect(f.session.status().value.kind).toBe("running");
    f.start(inputIdOf(next)); await f.end(inputIdOf(next));
    expect(f.session.status().value.kind).toBe("idle");
  } finally { vi.restoreAllMocks(); await f.session.dispose(); }
});
