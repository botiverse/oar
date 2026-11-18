import { afterEach, describe, expect, it, vi } from "vitest";
import { CybionClient } from "../../../packages/oar/src/community/cybion/client.js";
import { createCybionRuntime } from "../../../packages/oar/src/community/cybion/index.js";
import { createThreadTracker } from "../../../packages/oar/src/community/cybion/tracker.js";
import type { Event, Frame } from "../../../packages/oar/src/contracts/records.js";
import type { Session } from "../../../packages/oar/src/contracts/session.js";
import { eventsOf } from "../../../packages/oar/src/observe/events.js";
import { createSessionKernel } from "../../../packages/oar/src/shared/session-kernel.js";

const thread = {
  id: "t1",
  purpose: "chat",
  created_by: "api",
  external_ref: null,
  title: "work",
  model: "gpt-6",
  upstream_id: null,
  reasoning_effort: "low",
  service_tier_fast: false,
  context_budget_tokens: null,
  minimal_mode: null,
  image_generation_model: null,
  max_loaded_manuals: null,
  budget_usd_nanos: null,
  initial_manual_ids: null,
  audio_transcription_model: null,
  archived_at: null,
  context_tokens: null,
  status: "idle",
  display_status: "ready",
  running_summary: null,
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_tokens: 0, cache_hit_rate: null, cost_usd_nanos: 0, cost_settled_requests: 0 },
  created_at: 1,
  updated_at: 1,
};

const input = (id: number, content: string) => ({ id, thread_id: "t1", kind: "input", payload: { role: "user", content }, created_at: id });
const message = (id: number, text: string) => ({
  id,
  thread_id: "t1",
  kind: "response_output",
  payload: { type: "message", id: `m${String(id)}`, role: "assistant", content: [{ type: "output_text", text }] },
  created_at: id,
});

/**
 * A deployment in which an input is what makes the Thread run: every
 * `POST /inputs` appends the record Cybion would append and answers it, and
 * the test decides when the Thread goes idle again.
 */
function runningDeployment() {
  let nextId = 1;
  const state = { running: false, history: [] as unknown[] };
  const sent: string[] = [];
  const fetch = async (raw: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof raw === "string" ? raw : raw instanceof URL ? raw.href : raw.url);
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && url.pathname === "/v1/threads") {
      return json(thread);
    }
    if (method === "POST" && url.pathname === "/v1/threads/t1/inputs") {
      const body = JSON.parse(String(init?.body)) as { input: string };
      sent.push(body.input);
      const id = nextId;
      nextId += 1;
      state.history.push(input(id, body.input));
      state.running = true;
      return json({ thread_id: "t1", record_idx: id, status: "accepted" });
    }
    if (method === "GET" && url.pathname === "/v1/threads/t1/history") {
      return json([...state.history]);
    }
    if (method === "GET" && url.pathname === "/v1/threads/t1") {
      return json({ ...thread, status: state.running ? "running" : "idle", display_status: state.running ? "running" : "completed" });
    }
    return json({ error: `unscripted ${method} ${url.pathname}` }, 500);
  };
  return { fetch: fetch as typeof globalThis.fetch, state, sent };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the session never reached the state the test waits for");
}

describe("steering a cybion turn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("takes a mid-turn input into the running turn, which still ends once", async () => {
    const deployment = runningDeployment();
    vi.stubGlobal("fetch", deployment.fetch);
    const runtime = createCybionRuntime({ baseUrl: "https://cybion.test", apiKey: "cyb_me_secret" });
    expect(runtime.sessionCapabilities?.({ kind: "available", via: "bundled" })).toEqual({ steer: true, images: true });
    const session: Session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: "/work" });
    expect(session.steer).toBeDefined();
    const events: Event[] = [];
    session.events((event) => events.push(event));

    expect((await session.prompt("run the long command")).kind).toBe("accepted");
    await until(() => session.status().value.kind === "running");

    const steered = await session.steer("never mind, answer now");
    expect(steered).toMatchObject({ kind: "accepted", request: { body: { kind: "steer", input: "never mind, answer now" } } });
    // The input went into the turn that runs: nothing ended, and no second turn began.
    expect(session.status().value.kind).toBe("running");
    expect(events.filter((event) => event.kind === "turn_ended")).toHaveLength(0);
    expect(events.filter((event) => event.kind === "turn_started")).toHaveLength(1);

    deployment.state.history.push(message(3, "answered instead"));
    deployment.state.running = false;
    await until(() => session.status().value.kind === "idle");

    const kinds = events.map((event) => event.kind);
    expect(kinds.filter((kind) => kind === "turn_started")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "turn_ended")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "user_message").map((event) => event.input)).toEqual(["run the long command", "never mind, answer now"]);
    expect(events.find((event) => event.kind === "text_delta")).toMatchObject({ text: "answered instead" });
    await session.dispose();
  }, 20_000);

  it("answers no_active_turn when nothing runs, and sends nothing", async () => {
    const deployment = runningDeployment();
    vi.stubGlobal("fetch", deployment.fetch);
    const runtime = createCybionRuntime({ baseUrl: "https://cybion.test", apiKey: "cyb_me_secret" });
    const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: "/work" });

    const refused = await session.steer("nobody is listening");
    expect(refused).toMatchObject({ kind: "rejected", code: "no_active_turn" });
    expect(deployment.sent).toEqual([]);
    await session.dispose();
  }, 15_000);
});

interface Scripted {
  status: string;
  display: string;
  history: unknown[];
}

/** A tracking harness whose polls the test releases one at a time. */
function tracked(initial: Scripted) {
  const state: Scripted = { ...initial };
  let duringHistory: (() => void) | null = null;
  const fetch = async (raw: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof raw === "string" ? raw : raw instanceof URL ? raw.href : raw.url);
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname.endsWith("/history")) {
      const hook = duringHistory;
      duringHistory = null;
      hook?.();
      return json([...state.history]);
    }
    return json({ ...thread, status: state.status, display_status: state.display });
  };
  vi.stubGlobal("fetch", fetch);
  const kernel = createSessionKernel("t1");
  let release: (() => void) | null = null;
  const tracker = createThreadTracker({
    client: new CybionClient({ baseUrl: "https://cybion.test", apiKey: "cyb_me_secret" }),
    kernel,
    thread: { native: thread, id: "t1", status: "idle", displayStatus: "ready", title: "t", model: "m", effort: "low", contextTokens: null, usage: { input: 0, output: 0, cacheRead: 0 } },
    seen: 0,
    onIdle: () => undefined,
    wait: async () => await new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  const events = (): Event[] => kernel.records().flatMap((record) => (record.kind === "frame" ? eventsOf(record as Frame) : []));
  const nextPoll = async (): Promise<void> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (release !== null) {
        const go = release;
        release = null;
        go();
        return;
      }
      if (!tracker.busy()) {
        return;
      }
    }
    throw new Error("the tracker never asked for another poll");
  };
  return {
    state,
    tracker,
    events,
    ends: () => events().filter((event) => event.kind === "turn_ended"),
    nextPoll,
    /** Run `hook` inside the next poll's history read, before it answers. */
    duringNextHistory: (hook: () => void) => {
      duringHistory = hook;
    },
  };
}

describe("a steer's place in the tracked turn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the turn when the write lands while a status read already says idle", async () => {
    const harness = tracked({ status: "running", display: "running", history: [] });
    harness.tracker.follow(1);
    harness.state.history.push(input(1, "run the long command"), message(2, "still working"));
    await harness.nextPoll();
    harness.state.status = "idle";
    harness.state.display = "completed";
    await harness.nextPoll();
    expect(harness.ends()).toHaveLength(0);

    // The steer lands during the status read that would end the turn: the Thread
    // starts running again for it, so that read is already out of date.
    harness.duringNextHistory(() => {
      harness.tracker.steer(3);
    });
    await harness.nextPoll();
    expect(harness.ends()).toHaveLength(0);
    expect(harness.tracker.busy()).toBe(true);

    harness.state.status = "running";
    harness.state.display = "running";
    harness.state.history.push(input(3, "never mind, answer now"), message(4, "answered instead"));
    await harness.nextPoll();
    harness.state.status = "idle";
    harness.state.display = "completed";
    await harness.nextPoll();
    await harness.nextPoll();

    expect(harness.ends()).toHaveLength(1);
    expect(harness.ends()[0]).toMatchObject({ outcome: { kind: "completed" } });
    expect(harness.events().filter((event) => event.kind === "user_message").map((event) => event.input)).toEqual(["run the long command", "never mind, answer now"]);
    expect(harness.events().filter((event) => event.kind === "text_delta").at(-1)).toMatchObject({ text: "answered instead" });
    harness.tracker.close();
  }, 15_000);
});
