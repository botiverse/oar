import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { UnsupportedOptionError } from "../../../packages/oar/src/contracts/errors.js";
import type { ControlOutcome, Event, Session, SessionOptions } from "../../../packages/oar/src/contracts/session.js";
import { conversationOf } from "../../../packages/oar/src/observe/conversation.js";
import { initialSessionView, reduceSessionView } from "../../../packages/oar/src/observe/session-view.js";
import { ConsoleClient, type ConsoleLease, type ConsoleReply } from "../../../packages/oar/src/community/morph/console.js";
import { morphSessionWith } from "../../../packages/oar/src/community/morph/session.js";

type Route = (body: unknown, match: Record<string, string>) => ConsoleReply;

/**
 * A scripted Console Runtime API: each task answers its statuses one per
 * query (the last one repeats), snapshots are pushed by the test, and any
 * route can be overridden by its exact `METHOD /path`.
 */
class FakeConsole extends ConsoleClient {
  readonly calls: string[] = [];
  readonly bodies: unknown[] = [];
  readonly statuses = new Map<string, string[]>();
  readonly streams = new Map<string, (frame: unknown) => void>();
  readonly routes = new Map<string, Route>();
  private nextTask = 0;
  private readonly defaults: readonly [string, RegExp, Route][] = [
    ["POST", /^\/topics$/u, () => ({ status: 201, body: { id: "topic-1" } })],
    ["PUT", /^\/workspace$/u, () => ({ status: 200, body: {} })],
    ["POST", /^\/tasks$/u, () => this.created()],
    ["GET", /^\/tasks\/(?<task>[^/]+)$/u, (_body, { task = "" }) => this.queried(task)],
    ["POST", /^\/tasks\/(?<task>[^/]+)\/stop$/u, (_body, { task = "" }) => this.stopped(task)],
    ["GET", /^\/topic\/[^/]+\/metadata$/u, () => ({ status: 200, body: { context: { available: true, used_input_tokens: 100, context_window_tokens: 1000, usage_ratio: 0.1 } } })],
  ];

  constructor() {
    super({ url: "http://127.0.0.1:1/runtime", token: "t" });
  }

  override async call(method: string, route: string, body?: unknown): Promise<ConsoleReply> {
    this.calls.push(`${method} ${route}`);
    this.bodies.push(body);
    const scripted = this.routes.get(`${method} ${route}`);
    if (scripted !== undefined) {
      return scripted(body, {});
    }
    for (const [verb, pattern, handle] of this.defaults) {
      const match = verb === method ? pattern.exec(route) : null;
      if (match !== null) {
        return handle(body, { ...match.groups });
      }
    }
    return { status: 404, body: "not found" };
  }

  override stream(taskId: string, onFrame: (frame: unknown) => void): () => void {
    this.streams.set(taskId, onFrame);
    return () => {
      this.streams.delete(taskId);
    };
  }

  finish(taskId: string, status = "done"): void {
    this.statuses.set(taskId, [status]);
  }

  /** The `task` texts sent with `POST /tasks`, in order. */
  sent(): string[] {
    return this.bodies.flatMap((body) => {
      const task = body !== null && typeof body === "object" && "task" in body ? body.task : undefined;
      return typeof task === "string" ? [task] : [];
    });
  }

  private created(): ConsoleReply {
    this.nextTask += 1;
    const id = `task-${String(this.nextTask)}`;
    this.statuses.set(id, ["running"]);
    return { status: 200, body: { id, status: "queued", topic_id: "topic-1" } };
  }

  private queried(task: string): ConsoleReply {
    const queue = this.statuses.get(task) ?? ["running"];
    const status = queue.length > 1 ? queue.shift() : queue[0];
    return { status: 200, body: { id: task, status, ...(status === "done" ? { result: { final: { output: `answer of ${task}` } } } : {}) } };
  }

  private stopped(task: string): ConsoleReply {
    this.statuses.set(task, ["canceled"]);
    return { status: 200, body: { status: "stopping", found: true, task_id: task } };
  }
}

const installation = { kind: "available", via: "executable", command: "morph" } as const;

interface Opened {
  readonly session: Session;
  readonly events: Event[];
  readonly released: () => boolean;
}

async function open(fake: FakeConsole, options: Partial<SessionOptions> = {}): Promise<Opened> {
  let released = false;
  const lease: ConsoleLease = {
    client: fake,
    owned: false,
    onExit: () => undefined,
    release: async () => {
      released = true;
      return null;
    },
  };
  const session = await morphSessionWith(async () => lease)(installation, { cwd: "/work", ...options });
  const events: Event[] = [];
  session.events((event) => {
    events.push(event);
  });
  return { session, events, released: () => released };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    // oxlint-disable-next-line no-await-in-loop -- polling a condition.
    await delay(20);
  }
}

const answer = (outcome: ControlOutcome | undefined): string => (outcome?.kind === "rejected" ? outcome.code : outcome?.kind ?? "absent");
const turnEnds = (events: readonly Event[]): number => events.filter((event) => event.kind === "turn_ended").length;
const frameTypes = (session: Session): string[] => session.records().flatMap((record) => (record.kind === "frame" ? [record.body.type] : []));

test("open creates the topic and attaches cwd; Session.id is the topic id", async () => {
  const fake = new FakeConsole();
  const { session } = await open(fake);
  assert.equal(session.id, "topic-1");
  assert.deepEqual(fake.calls, ["POST /topics", "PUT /workspace"]);
  assert.deepEqual(fake.bodies[1], { topic_id: "topic-1", workspace_dir: "/work" });
  assert.deepEqual(session.capabilities, { queue: { durable: false }, attribution: "opaque", images: false });
  await session.dispose();
});

test("Console sessions leave placement unknown instead of claiming isolation or sharing", async () => {
  const { session } = await open(new FakeConsole());
  try {
    expect(session.placement).toBeNull();
    expect(session.records().some((record) => record.kind === "response" && record.body.kind === "opened")).toBe(false);
  } finally { await session.dispose(); }
});

// oxlint-disable-next-line eslint/max-statements -- one turn followed from prompt to its end, in order.
test("a turn: prompt, snapshots, busy, then the terminal task answer ends it with context usage", async () => {
  const fake = new FakeConsole();
  const { session, events } = await open(fake);
  assert.equal(answer(await session.prompt("hi")), "accepted");
  assert.deepEqual(fake.bodies.at(-1), { task: "hi", topic_id: "topic-1", workspace_dir: "/work" });
  await until(() => fake.streams.has("task-1"), "the stream");
  fake.streams.get("task-1")?.({ task_id: "task-1", seq: 1, status: "running", text: "answer" });
  assert.equal(answer(await session.prompt("again")), "busy");
  await until(() => frameTypes(session).includes("task/running"), "the running status");
  fake.finish("task-1");
  await until(() => turnEnds(events) === 1, "turn end");
  expect(events.map((event) => event.kind)).toEqual(["turn_started", "turn_active", "text_delta", "turn_started", "control_rejected", "usage", "text_delta", "turn_ended"]);
  assert.equal(session.contextUsage().value?.percent, 10);
  assert.equal(session.status().value.kind, "idle");
  assert.deepEqual(frameTypes(session), ["stream/running", "task/running", "topic/metadata", "task/done"]);
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- each steer answer Console can give, against one running turn.
test("steer: accepted when Console names the run it steered into; a run that ended first is followed as its own turn", async () => {
  const fake = new FakeConsole();
  const { session, events } = await open(fake);
  assert.equal(answer(await session.steer?.("early")), "no_active_turn");
  await session.prompt("work");
  fake.routes.set("POST /tasks", () => ({ status: 200, body: { id: "ack-1", status: "done", topic_id: "topic-1", steer_target_task_id: "task-1" } }));
  assert.equal(answer(await session.steer?.("more")), "accepted");
  fake.routes.set("POST /tasks", () => ({ status: 200, body: { id: "ack-2", status: "done", topic_id: "topic-1" } }));
  assert.equal(answer(await session.steer?.("lost")), "runtime_refused");
  fake.statuses.set("task-9", ["queued"]);
  fake.routes.set("POST /tasks", () => ({ status: 200, body: { id: "task-9", status: "queued", topic_id: "topic-1" } }));
  assert.equal(answer(await session.steer?.("late")), "accepted");
  fake.finish("task-1");
  await until(() => turnEnds(events) === 1 && fake.streams.has("task-9"), "the first turn end");
  // Text alone cannot establish a turn. A snapshot must name the followed running task.
  fake.streams.get("task-9")?.({ task_id: "task-9", seq: 1, text: "preview" });
  fake.streams.get("task-9")?.({ task_id: "other-task", status: "running" });
  assert.equal(session.status().value.kind, "idle");
  fake.streams.get("task-9")?.({ task_id: "task-9", seq: 2, status: "running", text: "late answer" });
  assert.equal(session.status().value.kind, "running");
  fake.finish("task-9");
  await until(() => turnEnds(events) === 2, "the spontaneous turn's end");
  await session.dispose();
});

test("a successor already reported running is adopted on its next poll once the old task settles", async () => {
  const fake = new FakeConsole();
  const { session, events } = await open(fake);
  try {
    await session.prompt("first");
    fake.routes.set("POST /tasks", () => ({ status: 200, body: { id: "next", status: "queued", topic_id: session.id } }));
    await session.steer?.("second");
    await until(() => fake.calls.includes("GET /tasks/next"), "the successor's first running poll");
    expect(events.filter(event => event.kind === "turn_active")).toHaveLength(1);
    fake.finish("task-1");
    await until(() => events.filter(event => event.kind === "turn_active").length === 2, "the successor's running poll after settlement");
    expect(session.status().value.kind).toBe("running");
    const running = { task_id: "next", status: "running" };
    fake.streams.get("next")?.(running);
    fake.streams.get("next")?.(running);
    expect(events.filter(event => event.kind === "turn_active")).toHaveLength(2);
    fake.finish("next");
  } finally { await session.dispose(); }
});

test("abort stops the running task and its canceled status ends the turn aborted", async () => {
  const fake = new FakeConsole();
  const { session, events } = await open(fake);
  assert.equal(answer(await session.abort()), "no_active_turn");
  await session.prompt("long");
  assert.equal(answer(await session.abort()), "accepted");
  assert.ok(fake.calls.includes("POST /tasks/task-1/stop"));
  await until(() => turnEnds(events) === 1, "turn end");
  expect(events.find((event) => event.kind === "turn_ended")).toMatchObject({ outcome: { kind: "aborted" } });
  await session.dispose();
});

test("abort maps 5xx from stopTask to error and 400 to runtime_refused", async () => {
  const fake = new FakeConsole();
  const { session } = await open(fake);
  await session.prompt("long");
  fake.routes.set("POST /tasks/task-1/stop", () => ({ status: 503, body: { error: "console unavailable" } }));
  const serverFailure = await session.abort();
  expect(serverFailure).toMatchObject({ kind: "rejected", code: "error", reason: "console unavailable" });
  expect(serverFailure.response.body).toMatchObject({ native: { error: "console unavailable" } });
  fake.routes.set("POST /tasks/task-1/stop", () => ({ status: 400, body: { error: "bad stop request" } }));
  const clientRefusal = await session.abort();
  expect(clientRefusal).toMatchObject({ kind: "rejected", code: "runtime_refused", reason: "bad stop request" });
  expect(clientRefusal.response.body).toMatchObject({ native: { error: "bad stop request" } });
  fake.routes.delete("POST /tasks/task-1/stop");
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- one held queue, withdrawn, drained and run, in order.
test("queue is held while busy, withdrawable, and sent as a spontaneous turn when the topic goes idle", async () => {
  const fake = new FakeConsole();
  const { session, events } = await open(fake);
  await session.prompt("first");
  const second = await session.queue("second", { origin: { kind: "automation", source: "ci" } });
  assert.deepEqual(second.response.body, { kind: "accepted", queued: "adapter" });
  const third = await session.queue("third", { inputId: "8f0c3d1e-0000-4000-8000-000000000003" });
  assert.deepEqual(third.response.body, { kind: "accepted", queued: "adapter" });
  assert.equal(answer(await session.withdraw?.("8f0c3d1e-0000-4000-8000-000000000003")), "accepted");
  const overtake: { status?: string; prompt?: ReturnType<Session["prompt"]> } = {};
  const unsubscribe = session.rawEvents((record) => {
    if (overtake.prompt !== undefined || record.kind !== "frame" || !record.body.events.some((event) => event.kind === "turn_ended")) {
      return;
    }
    overtake.status = session.status().value.kind;
    overtake.prompt = session.prompt("overtake");
  });
  fake.finish("task-1");
  await until(() => fake.statuses.has("task-2"), "the held input to be sent");
  unsubscribe();
  expect(overtake.status).toBe("running");
  expect(await overtake.prompt).toMatchObject({ kind: "rejected", code: "busy" });
  const secondId = second.request.kind === "request" && second.request.body.kind === "queue" ? second.request.body.inputId : undefined;
  assert.ok(secondId !== undefined);
  assert.equal(answer(await session.withdraw?.(secondId)), "not_queued");
  const dispatch = session.records().find((record) => record.kind === "request" && record.body.kind === "prompt" && record.body.carries?.includes(secondId) === true);
  assert.ok(dispatch?.kind === "request");
  expect(dispatch.body).toEqual({ kind: "prompt", input: "second", carries: [secondId], origin: { kind: "automation", source: "ci" } });
  assert.deepEqual(fake.sent(), ["first", "second"]);
  fake.finish("task-2");
  await until(() => turnEnds(events) === 2, "the queued turn's end");
  const view = session.records().reduce((state, record) => reduceSessionView(state, record), initialSessionView());
  expect(view.messages.filter((message) => message.kind === "input" && message.input.input === "second")).toHaveLength(1);
  await session.dispose();
});

test("queue while idle returns queued:'adapter' and dispatches with carries", async () => {
  const fake = new FakeConsole();
  const { session, events } = await open(fake);
  const liveId = "8f0c3d1e-0000-4000-8000-000000000012";
  const queued = await session.queue("run now", { inputId: liveId });
  expect(queued.response.body).toEqual({ kind: "accepted", queued: "adapter" });
  await until(() => fake.statuses.has("task-1"), "idle queued input dispatch");
  const dispatch = session.records().find((record) => record.kind === "request" && record.body.kind === "prompt" && record.body.carries?.includes(liveId) === true);
  expect(dispatch?.kind === "request" ? dispatch.body : undefined).toEqual({ kind: "prompt", input: "run now", carries: [liveId] });
  fake.finish("task-1");
  await until(() => turnEnds(events) === 1, "idle queued turn end");
  await session.dispose();
});

test("acceptance observer can withdraw a queued input before dispatch", async () => {
  const fake = new FakeConsole();
  const { session } = await open(fake);
  const inputId = "8f0c3d1e-0000-4000-8000-000000000011";
  const withdrawal: { value?: Promise<ControlOutcome> } = {};
  const unsubscribe = session.rawEvents((record) => {
    if (record.kind === "response" && record.body.kind === "accepted" && record.body.queued === "adapter") {
      withdrawal.value = session.withdraw?.(inputId);
    }
  });
  const withdrawnQueue = await session.queue("cancel me", { inputId });
  expect(withdrawnQueue.response.body).toEqual({ kind: "accepted", queued: "adapter" });
  expect(answer(await withdrawal.value)).toBe("accepted");
  unsubscribe();
  expect(fake.sent()).toEqual([]);
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- checks refusal drop, error mapping, and subsequent drain.
test("failed drain send records input_dropped on HTTP refusal and preserves ownership on transport throw", async () => {
  const fake = new FakeConsole();
  const { session, events } = await open(fake);
  await session.prompt("first");
  const refusedId = "8f0c3d1e-0000-4000-8000-000000000021";
  const droppedId = "8f0c3d1e-0000-4000-8000-000000000022";
  const finalId = "8f0c3d1e-0000-4000-8000-000000000023";
  await session.queue("bad-500", { inputId: refusedId });
  await session.queue("transport-fail", { inputId: droppedId });
  await session.queue("succeeds", { inputId: finalId });

  let attempt = 0;
  fake.routes.set("POST /tasks", () => {
    attempt += 1;
    if (attempt === 1) {
      return { status: 500, body: { error: "internal failure" } };
    }
    fake.routes.delete("POST /tasks");
    throw new Error("socket closed");
  });

  fake.finish("task-1");
  await until(() => events.some((event) => event.kind === "input_dropped"), "input_dropped on HTTP 500 refusal");
  await until(() => attempt === 2, "transport throw attempt");
  await delay(50);

  const convBeforeWithdraw = conversationOf(session.records());
  const firstHeld = [...convBeforeWithdraw.inputs.values()].find((entry) => entry.inputId === refusedId);
  expect(firstHeld).toMatchObject({ state: "dropped", reason: "runtime_refused" });
  expect(firstHeld?.attempts.at(-1)?.response?.body).toMatchObject({ kind: "rejected", code: "error" });

  // Transport failure kept the second queued item held without fabricating input_dropped.
  expect(events.filter((event) => event.kind === "input_dropped")).toMatchObject([
    { kind: "input_dropped", inputId: refusedId, reason: "runtime_refused", message: "internal failure" },
  ]);
  expect(session.status().value.kind).toBe("running");
  assert.equal(answer(await session.withdraw?.(droppedId)), "accepted");

  await until(() => fake.statuses.has("task-2"), "third held item to drain after withdrawal");
  expect(fake.sent().at(-1)).toBe("succeeds");
  fake.finish("task-2");
  await until(() => turnEnds(events) === 2, "final queued turn end");
  await session.dispose();
});

function gateTaskPosts(fake: FakeConsole, match?: (body: unknown) => boolean): {
  readonly started: Promise<void>;
  readonly release: () => void;
  readonly posted: unknown[];
} {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const posted: unknown[] = [];
  const originalCall = fake.call.bind(fake);
  fake.call = async (method, route, body) => {
    if (method === "POST" && route === "/tasks") {
      posted.push(body);
      if (match === undefined || match(body)) {
        started.resolve();
        await release.promise;
      }
    }
    return originalCall(method, route, body);
  };
  return { started: started.promise, release: () => { release.resolve(); }, posted };
}

test("transient transport error during drain leaves held[0] withdrawable and unblocked when draining resumes", async () => {
  const fake = new FakeConsole();
  const { session, events } = await open(fake);
  await session.prompt("init");
  const firstId = "8f0c3d1e-0000-4000-8000-000000000031";
  const secondId = "8f0c3d1e-0000-4000-8000-000000000032";
  const thirdId = "8f0c3d1e-0000-4000-8000-000000000033";
  await session.queue("withdrawable", { inputId: firstId });
  await session.queue("resumed", { inputId: secondId });
  await session.queue("trailing", { inputId: thirdId });

  let attempts = 0;
  fake.routes.set("POST /tasks", () => {
    attempts += 1;
    if (attempts === 2) { fake.routes.delete("POST /tasks"); }
    throw new Error("socket closed");
  });

  fake.finish("task-1");
  await until(() => attempts === 1, "first drain transport throw");
  await delay(40);
  expect(attempts).toBe(1);
  expect(events.filter((event) => event.kind === "input_dropped")).toEqual([]);
  assert.equal(answer(await session.withdraw?.(firstId)), "accepted");

  await until(() => attempts === 2, "second drain transport throw");
  await delay(40);
  expect(attempts).toBe(2);
  expect(events.filter((event) => event.kind === "input_dropped")).toEqual([]);
  expect(session.status().value.kind).toBe("running");
  expect(fake.statuses.has("task-2")).toBe(false);

  // Resume draining without withdrawing held[0] ("resumed"): it drains cleanly and unblocks "trailing".
  expect(answer(await session.prompt("overtake"))).toBe("busy");
  await until(() => fake.statuses.has("task-2"), "held[0] drained on resume without withdrawal");
  expect(fake.sent().slice(-1)).toEqual(["resumed"]);
  fake.finish("task-2");
  await until(() => fake.statuses.has("task-3"), "trailing held item drained");
  expect(fake.sent().slice(-1)).toEqual(["trailing"]);
  fake.finish("task-3");
  await until(() => turnEnds(events) === 3, "all three turns ended");
  await session.dispose();
});

test("concurrent idle prompt calls cannot both POST /tasks", async () => {
  const fake = new FakeConsole();
  const { session, events } = await open(fake);
  const gate = gateTaskPosts(fake);
  const first = session.prompt("first");
  const second = session.prompt("second");
  await gate.started;
  expect(await second).toMatchObject({ kind: "rejected", code: "busy" });
  expect(gate.posted).toHaveLength(1);
  expect(gate.posted[0]).toMatchObject({ task: "first" });
  gate.release();
  expect(await first).toMatchObject({ kind: "accepted" });
  expect(fake.sent()).toEqual(["first"]);
  fake.finish("task-1");
  await until(() => turnEnds(events) === 1, "first turn ended");
  await session.dispose();
});

test("prompt rejects as busy while an in-flight steer submission finishes past turn end", async () => {
  const fake = new FakeConsole();
  const { session, events } = await open(fake);
  await session.prompt("init");
  const gate = gateTaskPosts(fake, (body) => body !== null && typeof body === "object" && "task" in body && body.task === "steered");
  const steered = session.steer?.("steered");
  await gate.started;
  fake.finish("task-1");
  await until(() => turnEnds(events) === 1, "active task ended while steer POST /tasks is in flight");
  expect(session.status().value.kind).toBe("idle");
  expect(await session.prompt("raced")).toMatchObject({ kind: "rejected", code: "busy" });
  expect(gate.posted).toHaveLength(1);
  expect(gate.posted[0]).toMatchObject({ task: "steered" });
  gate.release();
  expect(await steered).toMatchObject({ kind: "accepted" });
  fake.finish("task-2");
  await until(() => turnEnds(events) === 2, "steered task ended");
  await session.dispose();
});

test("reentrant queue calls drain in recorded request order", async () => {
  const fake = new FakeConsole();
  const { session, events } = await open(fake);
  const secondQueue: { value?: ReturnType<Session["queue"]> } = {};
  const unsubOrder = session.rawEvents((record) => {
    if (record.kind === "request" && record.body.kind === "queue" && record.body.input === "first-q") {
      secondQueue.value = session.queue("second-q");
    }
  });
  await session.queue("first-q");
  await secondQueue.value;
  unsubOrder();
  await until(() => fake.statuses.has("task-1"), "first reentrant queue started");
  expect(fake.sent()).toEqual(["first-q"]);
  fake.finish("task-1");
  await until(() => fake.statuses.has("task-2"), "second reentrant queue started");
  expect(fake.sent()).toEqual(["first-q", "second-q"]);
  fake.finish("task-2");
  await until(() => turnEnds(events) === 2, "both reentrant turns finished");
  await session.dispose();
});

test("dispatch-observer dispose prevents sending the carried prompt", async () => {
  const fakeDispose = new FakeConsole();
  const { session } = await open(fakeDispose);
  const disposed: { value?: Promise<void> } = {};
  session.rawEvents((record) => {
    if (record.kind === "request" && record.body.kind === "prompt" && record.body.carries !== undefined) {
      disposed.value = session.dispose();
    }
  });
  await session.queue("blocked-by-dispose");
  await disposed.value;
  expect(fakeDispose.sent()).toEqual([]);
  const dispatchReq = session.records().find((record) => record.kind === "request" && record.body.kind === "prompt");
  assert.ok(dispatchReq?.kind === "request");
  expect(session.records().find((record) => record.kind === "response" && record.requestId === dispatchReq.id)).toMatchObject({
    body: { kind: "rejected", code: "disposed" },
  });
});

test("queue during an in-flight prompt waits until the prompt settles, even on refusal", async () => {
  const fakeFlight = new FakeConsole();
  const { session, events } = await open(fakeFlight);
  const promptStarted = Promise.withResolvers<void>();
  const releasePrompt = Promise.withResolvers<void>();
  const posted: unknown[] = [];
  const originalCall = fakeFlight.call.bind(fakeFlight);
  fakeFlight.call = async (method, route, body) => {
    if (method === "POST" && route === "/tasks") {
      posted.push(body);
    }
    if (method === "POST" && route === "/tasks" && body !== null && typeof body === "object" && "task" in body && body.task === "inflight") {
      promptStarted.resolve();
      await releasePrompt.promise;
      return { status: 400, body: { error: "rejected prompt" } };
    }
    return originalCall(method, route, body);
  };
  const promptOutcome = session.prompt("inflight");
  await promptStarted.promise;
  const queuedDuringFlight = await session.queue("queued-during-flight");
  expect(queuedDuringFlight.response.body).toEqual({ kind: "accepted", queued: "adapter" });
  expect(posted).toHaveLength(1);
  releasePrompt.resolve();
  expect(await promptOutcome).toMatchObject({ kind: "rejected", code: "runtime_refused" });
  await until(() => fakeFlight.statuses.has("task-1"), "queued item drained after in-flight prompt failed");
  expect(posted).toHaveLength(2);
  expect(fakeFlight.sent()).toEqual(["queued-during-flight"]);
  fakeFlight.finish("task-1");
  await until(() => turnEnds(events) === 1, "drained turn after prompt failure");
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- the approval round trip inside one turn.
test("an approval the task waits on is recorded and approved", async () => {
  const fake = new FakeConsole();
  const { session, events } = await open(fake);
  await session.prompt("install it");
  fake.routes.set("GET /tasks/task-1", () => ({ status: 200, body: { id: "task-1", status: "pending", approval_request_id: "apr-1" } }));
  fake.routes.set("GET /approvals/apr-1", () => ({ status: 200, body: { approval_request_id: "apr-1", tool_name: "skill_install" } }));
  fake.routes.set("POST /approvals/apr-1/approve", () => ({ status: 200, body: { approval_request_id: "apr-1", status: "approved", resumed: true } }));
  await until(() => events.some((event) => event.kind === "app_answered"), "the approval answer");
  expect(events.filter((event) => event.kind === "app_request" || event.kind === "app_answered")).toMatchObject([
    { kind: "app_request", requestId: "apr-1", type: "approval" },
    { kind: "app_answered", requestId: "apr-1" },
  ]);
  fake.routes.delete("GET /tasks/task-1");
  fake.finish("task-1");
  await until(() => turnEnds(events) === 1, "turn end");
  assert.equal(fake.calls.filter((call) => call === "POST /approvals/apr-1/approve").length, 1);
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- the dispose request, its answer and the session after it.
test("dispose stops running work, releases the Console, and answers accepted for a Console it did not stop", async () => {
  const fake = new FakeConsole();
  const { session, released } = await open(fake);
  await session.prompt("long");
  await session.dispose();
  assert.ok(fake.calls.includes("POST /tasks/task-1/stop"));
  assert.ok(released());
  const records = session.records();
  const dispose = records.find((record) => record.kind === "request" && record.body.kind === "dispose");
  const disposeId = dispose?.kind === "request" ? dispose.id : "";
  expect(records.find((record) => record.kind === "response" && record.requestId === disposeId)).toMatchObject({ body: { kind: "accepted" } });
  assert.equal(answer(await session.prompt("after")), "disposed");
});

test("resume checks the topic and attaches the session's cwd again", async () => {
  const fake = new FakeConsole();
  fake.routes.set("GET /topics/topic-7", () => ({ status: 200, body: { id: "topic-7" } }));
  const { session } = await open(fake, { resume: "topic-7", cwd: "/elsewhere" });
  assert.equal(session.id, "topic-7");
  assert.deepEqual(fake.bodies.at(-1), { topic_id: "topic-7", workspace_dir: "/elsewhere" });
  await session.dispose();
});

test("options morph cannot honor, an unknown topic and a Console without POST /topics refuse the open", async () => {
  await expect(open(new FakeConsole(), { resume: "missing" })).rejects.toThrow("morph has no topic missing to resume");
  await expect(open(new FakeConsole(), { systemPrompt: "x" })).rejects.toBeInstanceOf(UnsupportedOptionError);
  await expect(open(new FakeConsole(), { env: { A: "1" } })).rejects.toBeInstanceOf(UnsupportedOptionError);
  await expect(open(new FakeConsole(), { launchArgs: ["--flag"] })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "launchArgs" });
  await expect(open(new FakeConsole(), { resume: "topic-7", fork: {} })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "fork" });
  await expect(open(new FakeConsole(), { effort: "high" })).rejects.toThrow("effort high");
  const old = new FakeConsole();
  old.routes.set("POST /topics", () => ({ status: 405, body: "method not allowed" }));
  await expect(open(old)).rejects.toThrow("POST /topics");
});

test("model is an LLM profile, checked at open and sent with every task", async () => {
  const fake = new FakeConsole();
  fake.routes.set("GET /llm/profiles", () => ({ status: 200, body: { default: { name: "default" }, items: [{ name: "codex", model: "gpt-5.6-luna" }] } }));
  const { session } = await open(fake, { model: "codex" });
  await session.prompt("hi");
  expect(fake.bodies.at(-1)).toMatchObject({ llm_profile: "codex" });
  await session.dispose();
  await expect(open(fake, { model: "nope" })).rejects.toThrow("morph has no LLM profile nope (configured: default, codex)");
});
