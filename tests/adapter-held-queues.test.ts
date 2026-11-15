/* oxlint-disable max-statements -- Pin ownership at each synchronous dispatch boundary. */
import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { initialStatus, reduceStatus, statusOf, statusValue, type StatusState } from "../packages/oar/src/observe/agent-status.js";
import { conversationOf } from "../packages/oar/src/observe/conversation.js";
import { initialSessionView, reduceSessionView } from "../packages/oar/src/observe/session-view.js";
import heldQueueSession from "./fixtures/held-queue-session.js";
import { inputIdOf, withdraw } from "./fixtures/withdraw.js";

test.each(["claude", "qoder", "qwen", "cursor"] as const)("%s records held ownership and one logical input across dispatch and replay", async name => {
  const f = await heldQueueSession(name);
  try {
    const first = await f.session.prompt("A"); f.start(inputIdOf(first));
    const queued = await f.session.queue("B", { origin: { kind: "automation", source: "test" } });
    expect(queued.response.body).toEqual({ kind: "accepted", queued: "adapter" });
    const terminal: { status: string; prompt: ReturnType<typeof f.session.prompt> }[] = [];
    const unsubscribe = f.session.rawEvents(record => {
      if (terminal.length > 0 || record.kind !== "frame" || !record.body.events.some(event => event.kind === "turn_ended")) { return; }
      terminal.push({ status: f.session.status().value.kind, prompt: f.session.prompt("overtake") });
    });
    await f.end(inputIdOf(first)); unsubscribe();
    expect(terminal[0]?.status).toBe("running");
    expect(await terminal[0]?.prompt).toMatchObject({ kind: "rejected", code: "busy" });
    const dispatch = f.session.records().find(record => record.kind === "request" && record.body.kind === "prompt" && record.body.carries?.includes(inputIdOf(queued)) === true);
    assert.ok(dispatch?.kind === "request");
    expect(dispatch.body).toEqual({ kind: "prompt", input: "B", carries: [inputIdOf(queued)], origin: { kind: "automation", source: "test" } });
    expect(await withdraw(f.session, inputIdOf(queued))).toBe("not_queued");
    expect(f.session.status().value.kind).toBe("running");
    f.start(inputIdOf(queued)); await f.end(inputIdOf(queued));
    expect(f.session.status().value.kind).toBe("idle");
    expect(f.session.records().filter(record => record.kind === "response" && record.requestId === queued.request.id)).toHaveLength(1);
    const inputs = [...conversationOf(f.session.records()).inputs.values()].filter(input => input.inputId === inputIdOf(queued));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.attempts.map(attempt => attempt.request.body.kind)).toEqual(["queue", "prompt", "withdraw"]);
    const view = f.session.records().reduce((state, record) => reduceSessionView(state, record), initialSessionView());
    expect(view.messages.filter(message => message.kind === "input" && message.input.input === "B")).toHaveLength(1);
    let checkpoint = initialStatus;
    for (const record of f.session.records()) {
      // oxlint-disable-next-line typescript/no-unsafe-assignment, unicorn/prefer-structured-clone -- Persist the public JSON checkpoint at every boundary.
      const saved: StatusState = JSON.parse(JSON.stringify(checkpoint));
      checkpoint = reduceStatus(saved, record, f.session.id);
      expect(statusValue(checkpoint)).toEqual(statusOf(f.session.records().filter(value => value.seq <= record.seq), f.session.id).value);
    }
    expect(statusValue(checkpoint)).toEqual(f.session.status().value);
  } finally { await f.session.dispose(); }
});

test.each(["claude", "qoder", "qwen", "cursor"] as const)("%s rejects a reentrant carried overtake without stealing the queue identity", async name => {
  const f = await heldQueueSession(name);
  try {
    const first = await f.session.prompt("A"); f.start(inputIdOf(first));
    const queued = await f.session.queue("B");
    const reentrant: { value?: ReturnType<typeof f.session.prompt> } = {};
    const unsubscribe = f.session.rawEvents(record => {
      if (reentrant.value !== undefined || record.kind !== "frame" || !record.body.events.some(event => event.kind === "turn_ended")) { return; }
      reentrant.value = f.session.prompt("stolen", { carries: [inputIdOf(queued)] });
    });
    await f.end(inputIdOf(first)); unsubscribe();
    expect(await reentrant.value).toMatchObject({ kind: "rejected", code: "busy" });
    expect(f.session.status().value.kind).toBe("running");
    const original = [...conversationOf(f.session.records()).inputs.values()].find(input => input.inputId === inputIdOf(queued));
    expect(original?.attempts.map(attempt => [attempt.request.body.kind, attempt.state])).toEqual([["queue", "accepted"], ["prompt", "rejected"], ["prompt", "accepted"]]);
    f.start(inputIdOf(queued)); await f.end(inputIdOf(queued));
    const view = f.session.records().reduce((state, record) => reduceSessionView(state, record), initialSessionView());
    expect(view.messages.filter(message => message.kind === "input" && message.input.input === "B")).toHaveLength(1);
    expect(f.session.status().value.kind).toBe("idle");
  } finally { await f.session.dispose(); }
});

test.each(["claude", "qoder", "qwen"] as const)("%s dispatch without inputId uses the queue request identity in its own stream", async name => {
  const f = await heldQueueSession(name);
  assert.ok(f.adapter !== undefined);
  try {
    const queued = await f.adapter.queue("no id");
    f.start(); await f.end();
    const dispatch = f.session.records().find(record => record.kind === "request" && record.body.kind === "prompt");
    expect(dispatch?.body).toEqual({ kind: "prompt", input: "no id", carries: [queued.request.id] });
    const view = f.session.records().reduce((state, record) => reduceSessionView(state, record, "stream"), initialSessionView());
    expect(view.messages.filter(message => message.kind === "input")).toHaveLength(1);
    expect(view.status.kind).toBe("idle");
  } finally { await f.session.dispose(); }
});

test.each(["claude", "qoder"] as const)("%s native refusal returns a dispatched input before notifying synchronous observers", async name => {
  const f = await heldQueueSession(name);
  assert.ok(f.emit !== undefined);
  try {
    const queued = await f.session.queue("duplicate");
    const observed: { status: string; prompt: ReturnType<typeof f.session.prompt> }[] = [];
    f.session.rawEvents(record => {
      if (record.kind !== "frame" || !record.body.events.some(event => event.kind === "input_dropped")) { return; }
      observed.push({ status: f.session.status().value.kind, prompt: f.session.prompt("next") });
    });
    f.emit({ type: "command_lifecycle", command_uuid: inputIdOf(queued), state: "completed" });
    expect(observed[0]?.status).toBe("idle");
    expect(await observed[0]?.prompt).toMatchObject({ kind: "accepted" });
    expect([...conversationOf(f.session.records()).inputs.values()].find(input => input.inputId === inputIdOf(queued))?.state).toBe("dropped");
  } finally { await f.session.dispose(); }
});

test.each(["claude", "qoder", "qwen", "cursor"] as const)("%s lets an acceptance observer withdraw before dispatch", async name => {
  const f = await heldQueueSession(name);
  try {
    const withdrawal: { value?: Promise<string> } = {};
    f.session.rawEvents(record => {
      if (record.kind !== "response" || record.body.kind !== "accepted" || record.body.queued !== "adapter") { return; }
      const request = f.session.records().find(value => value.kind === "request" && value.id === record.requestId);
      assert.ok(request?.kind === "request" && request.body.kind === "queue" && request.body.inputId !== undefined);
      withdrawal.value = withdraw(f.session, request.body.inputId);
    });
    await f.session.queue("withdraw now");
    expect(await withdrawal.value).toBe("accepted");
    expect(f.written()).toEqual([]);
    expect(f.session.status().value.kind).toBe("idle");
    expect(await f.session.prompt("still usable")).toMatchObject({ kind: "accepted" });
  } finally { await f.session.dispose(); }
});
