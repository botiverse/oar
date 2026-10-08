import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { UnsupportedOptionError } from "../../../packages/oar/src/contracts/errors.js";
import type { ControlOutcome, Event, Session, SessionOptions } from "../../../packages/oar/src/contracts/session.js";
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
  expect(events.map((event) => event.kind)).toEqual(["turn_started", "text_delta", "turn_started", "control_rejected", "usage", "text_delta", "turn_ended"]);
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
  fake.statuses.set("task-9", ["running"]);
  fake.routes.set("POST /tasks", () => ({ status: 200, body: { id: "task-9", status: "queued", topic_id: "topic-1" } }));
  assert.equal(answer(await session.steer?.("late")), "accepted");
  fake.finish("task-1");
  await until(() => turnEnds(events) === 1 && fake.streams.has("task-9"), "the first turn end");
  // The steer's own task is followed: its first snapshot adopts the turn.
  fake.streams.get("task-9")?.({ task_id: "task-9", seq: 2, status: "running", text: "late answer" });
  assert.equal(session.status().value.kind, "running");
  fake.finish("task-9");
  await until(() => turnEnds(events) === 2, "the spontaneous turn's end");
  await session.dispose();
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

// oxlint-disable-next-line eslint/max-statements -- one held queue, withdrawn, drained and run, in order.
test("queue is held while busy, withdrawable, and sent as a spontaneous turn when the topic goes idle", async () => {
  const fake = new FakeConsole();
  const { session, events } = await open(fake);
  await session.prompt("first");
  assert.equal(answer(await session.queue("second")), "accepted");
  await session.queue("third", { inputId: "8f0c3d1e-0000-4000-8000-000000000003" });
  assert.equal(answer(await session.withdraw?.("8f0c3d1e-0000-4000-8000-000000000003")), "accepted");
  fake.finish("task-1");
  await until(() => fake.statuses.has("task-2"), "the held input to be sent");
  assert.deepEqual(fake.sent(), ["first", "second"]);
  fake.finish("task-2");
  await until(() => turnEnds(events) === 2, "the queued turn's end");
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
