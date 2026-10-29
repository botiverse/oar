/* oxlint-disable eslint/max-statements, import/max-dependencies -- Each ACP scenario keeps its full control and projection evidence together. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import type { DeliverMergeInput, Session } from "../packages/oar/src/contracts/session.js";
import { kimiAcpProfile } from "../packages/oar/src/runtimes/kimi/session.js";
import { antigravityAcpProfile } from "../packages/oar/src/runtimes/antigravity/session.js";
import { opencodeV2AcpProfile } from "../packages/oar/src/runtimes/opencode/session.js";
import { acpSession, type AcpSessionProfile } from "../packages/oar/src/shared/acp/session.js";
import { conversationOf } from "../packages/oar/src/observe/conversation.js";
import { awaitTurnEnd } from "../packages/oar/src/observe/turns.js";
import { initialSessionView, reduceSessionView } from "../packages/oar/src/observe/session-view.js";

const profiles = [{ name: "kimi", profile: kimiAcpProfile }, { name: "antigravity", profile: antigravityAcpProfile }, { name: "opencode-v2", profile: opencodeV2AcpProfile }];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(async (cleanup) => { await cleanup(); })); });

async function fixture(profile: AcpSessionProfile, mode = "tools") {
  const dir = await mkdtemp(path.join(tmpdir(), "interrupt-"));
  const control = path.join(dir, "control");
  const image = path.join(dir, "shot.png");
  await writeFile(image, "png");
  const session = await acpSession({ ...profile, args: [fileURLToPath(new URL("fixtures/fake-acp-interrupt.mjs", import.meta.url)), control, mode], abortTimeoutMs: 50, usageUpdateTimeoutMs: 10 })(
    { kind: "available", via: "executable", command: process.execPath }, { cwd: dir },
  );
  cleanups.push(async () => { await session.dispose(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { session, image, command: async (command: string) => { await writeFile(control, command); } };
}
function requests(session: Session, kind: string) {
  return session.records().filter((record) => record.kind === "request" && record.body.kind === kind);
}
function text(session: Session) {
  return session.records().flatMap((record) => record.kind === "frame" ? record.body.events.flatMap((event) => event.kind === "text_delta" ? [event.text] : []) : []);
}
async function working(session: Session) {
  await session.prompt("work");
  await expect.poll(() => session.records().some((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "tool_call_started" && event.callId === "two"))).toBe(true);
}

for (const { name, profile } of profiles) {
  test(`${name}: prompt refuses carries of an input that is still queued`, async () => {
    const { session } = await fixture(profile);
    await working(session);
    const queued = await session.queue("still queued");
    if (queued.request.body.kind !== "queue") { throw new Error("expected queue"); }
    const inputId = queued.request.body.inputId ?? "";
    const result = await session.prompt("false merge", { carries: [inputId] });
    expect(result).toMatchObject({ kind: "rejected", code: "unsupported", reason: `carries input ${inputId} is not a withdrawn input owned by this session and agent` });
    const original = conversationOf(session.records()).inputs.get(JSON.stringify([session.id, [], inputId]));
    expect(original).toMatchObject({ input: "still queued", state: "accepted" });
    expect(original?.attempts).toHaveLength(1);
    expect(await session.withdraw?.(inputId)).toMatchObject({ kind: "accepted" });
  });

  test(`${name}: waits for every root tool, withdraws every input, then sends one merged prompt`, async () => {
    const { session, command } = await fixture(profile);
    await working(session);
    const earlier = await session.queue("first");
    const pending = session.deliver("second", { when: "interrupt", maxWaitMs: 5000 });
    await expect.poll(() => requests(session, "queue").length).toBe(2);
    await command("tool:one");
    await expect.poll(() => session.records().some((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "tool_call_ended" && event.callId === "one"))).toBe(true);
    expect(requests(session, "abort")).toHaveLength(0);
    await command("tool:two");
    const delivered = await pending;
    expect(delivered.landed).toBe("prompted");
    if (delivered.landed !== "prompted") { return; }
    expect(delivered.mergedInputIds).toEqual([earlier.request.body.kind === "queue" ? earlier.request.body.inputId : "", delivered.inputId]);
    await awaitTurnEnd(session, delivered.result.seq);
    expect(text(session)).toEqual(["working", JSON.stringify([{ type: "text", text: "first\n\nsecond" }])]);
    const controls = session.records().filter((record) => record.kind === "request").map((record) => record.body.kind);
    expect(controls).toEqual(["open", "prompt", "queue", "queue", "withdraw", "withdraw", "abort", "prompt"]);
    expect([...conversationOf(session.records()).inputs.values()].filter((input) => delivered.mergedInputIds?.includes(input.inputId ?? "") === true).map((input) => [input.input, input.state])).toEqual([["first", "accepted"], ["second", "accepted"]]);
  });

  test(`${name}: natural completion collects synchronously before the queue drain, without abort`, async () => {
    const { session, command } = await fixture(profile);
    await working(session);
    await session.queue("earlier");
    const pending = session.deliver("next", { when: "interrupt", maxWaitMs: 5000 });
    await expect.poll(() => requests(session, "queue").length).toBe(2);
    let live = initialSessionView();
    const unsubscribe = session.rawEvents((record) => { live = reduceSessionView(live, record); }, { sessionId: session.id, afterSeq: -1 });
    await command("end");
    const delivered = await pending;
    expect(delivered.landed).toBe("prompted");
    if (delivered.landed !== "prompted") { return; }
    await awaitTurnEnd(session, delivered.result.seq);
    expect(requests(session, "abort")).toHaveLength(0);
    expect(text(session)).toEqual(["working", JSON.stringify([{ type: "text", text: "earlier\n\nnext" }])]);
    expect(live).toEqual(session.records().reduce((view, record) => reduceSessionView(view, record), initialSessionView()));
    expect(live.messages.flatMap((message) => message.kind === "input" ? [[message.input.input, message.input.state]] : [])).toEqual([["work", "accepted"], ["earlier", "accepted"], ["next", "accepted"]]);
    unsubscribe();
  });

  test(`${name}: deadline interrupts unfinished tools; a forced process exit returns all input identities`, async () => {
    const { session } = await fixture(profile, "ignore-cancel");
    await working(session);
    const queued = await session.queue("saved");
    const delivered = await session.deliver("urgent", { when: "interrupt", maxWaitMs: 20 });
    expect(delivered.landed).toBe("rejected");
    if (delivered.landed !== "rejected") { return; }
    expect(delivered.code).toBe("runtime_exited");
    expect(delivered.undeliveredInputIds).toEqual([queued.request.body.kind === "queue" ? queued.request.body.inputId : "", delivered.inputId]);
    expect(requests(session, "prompt")).toHaveLength(1);
    expect(session.records().flatMap((record) => record.kind === "frame" ? record.body.events.filter((event) => event.kind === "turn_ended") : [])).toEqual([]);
  });
}

test("concurrent interrupts merge once in queue order, preserving image paths and input origins", async () => {
  const { session, image, command } = await fixture(opencodeV2AcpProfile);
  await working(session);
  let received: readonly DeliverMergeInput[] = [];
  const origin = { kind: "notification", source: "build" } as const;
  const first = session.deliver("one", { when: "interrupt", maxWaitMs: 5000, images: [{ path: image }], origin, merge: (inputs) => {
    received = inputs;
    return { input: inputs.map((input) => input.input.toUpperCase()).join("+"), images: inputs.flatMap((input) => input.images ?? []) };
  } });
  const second = session.deliver("two", { when: "interrupt", maxWaitMs: 5000 });
  await expect.poll(() => requests(session, "queue").length).toBe(2);
  await command("end");
  const outcomes = await Promise.all([first, second]);
  expect(outcomes.map((result) => result.landed)).toEqual(["prompted", "prompted"]);
  expect(received).toEqual([{ inputId: outcomes[0].inputId, input: "one", images: [{ path: image }], origin }, { inputId: outcomes[1].inputId, input: "two" }]);
  expect(requests(session, "prompt")).toHaveLength(2);
  const prompt = requests(session, "prompt").at(-1);
  expect(prompt?.body).toMatchObject({ input: "ONE+TWO", images: [{ path: image }], carries: outcomes.map((result) => result.inputId) });
});

test.each([() => ({ input: "" }), () => { throw new Error("merger failed"); }])("a failed merger returns all withdrawn input ids (%#)", async (merge) => {
    const { session } = await fixture(kimiAcpProfile);
    await working(session);
    const queued = await session.queue("saved");
    const delivered = await session.deliver("urgent", { when: "interrupt", maxWaitMs: 0, merge });
    expect(delivered.landed).toBe("rejected");
    if (delivered.landed === "rejected") {
      expect(delivered.undeliveredInputIds).toEqual([queued.request.body.kind === "queue" ? queued.request.body.inputId : "", delivered.inputId]);
    }
});

test("rejected concurrent queue attempts release the coordinator for the next interrupt", async () => {
  const { session } = await fixture(opencodeV2AcpProfile);
  await working(session);
  const refused = await Promise.all([session.deliver("", { when: "interrupt", maxWaitMs: 0 }), session.deliver("", { when: "interrupt", maxWaitMs: 0 })]);
  expect(refused.map((result) => result.landed)).toEqual(["rejected", "rejected"]);
  const next = await session.deliver("valid", { when: "interrupt", maxWaitMs: 0 });
  expect(next.landed).toBe("prompted");
});

test("interrupt uses an immediate boundary when no root tools are active", async () => {
  const { session } = await fixture(antigravityAcpProfile, "no-tools");
  await session.prompt("work");
  await expect.poll(() => text(session)).toEqual(["working"]);
  const next = await session.deliver("next", { when: "interrupt", maxWaitMs: 5000 });
  expect(next.landed).toBe("prompted");
  expect(requests(session, "abort")).toHaveLength(1);
});

test("an unexpected exit while waiting returns every held input without a replacement prompt", async () => {
  const { session, command } = await fixture(kimiAcpProfile);
  await working(session);
  const earlier = await session.queue("saved");
  const pending = session.deliver("urgent", { when: "interrupt", maxWaitMs: 5000 });
  await expect.poll(() => requests(session, "queue").length).toBe(2);
  await command("exit");
  const result = await pending;
  expect(result).toMatchObject({ landed: "rejected", code: "runtime_exited" });
  expect(result.undeliveredInputIds).toEqual([earlier.request.body.kind === "queue" ? earlier.request.body.inputId : "", result.inputId]);
  expect(requests(session, "prompt")).toHaveLength(1);
});

test("tools in a derived child session do not postpone the root interruption", async () => {
  const { session } = await fixture(kimiAcpProfile, "child-only");
  await session.prompt("work");
  await expect.poll(() => session.records().some((record) => record.sessionId === "child-fixture" && record.kind === "frame")).toBe(true);
  const pending = session.deliver("urgent", { when: "interrupt", maxWaitMs: 5000 });
  await expect.poll(() => requests(session, "abort").length).toBe(1);
  const result = await pending;
  expect(result.landed).toBe("prompted");
});

test("default merging keeps image order and a deliver arriving during withdrawal runs after the batch", async () => {
  const { session, image } = await fixture(antigravityAcpProfile);
  await working(session);
  await session.queue("first", { images: [{ path: image }] });
  const late: ReturnType<Session["deliver"]>[] = [];
  const unsubscribe = session.rawEvents((record) => {
    if (record.kind === "request" && record.body.kind === "withdraw" && late.length === 0) {
      late.push(session.deliver("after", { when: "after_turn" }));
    }
  });
  const result = await session.deliver("second", { when: "interrupt", maxWaitMs: 0, images: [{ path: image }] });
  expect(result.landed).toBe("prompted");
  const following = await Promise.all(late);
  expect(following.map((entry) => entry.landed)).not.toContain("rejected");
  await expect.poll(() => text(session).length).toBe(3);
  expect(requests(session, "prompt")[1]?.body).toMatchObject({ input: "first\n\nsecond", images: [{ path: image }, { path: image }] });
  expect(text(session).at(-1)).toBe(JSON.stringify([{ type: "text", text: "after" }]));
  unsubscribe();
});
