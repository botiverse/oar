import { afterEach, describe, expect, it, vi } from "vitest";
import { CybionClient } from "../../../packages/oar/src/community/cybion/client.js";
import { createThreadTracker } from "../../../packages/oar/src/community/cybion/tracker.js";
import type { Event, Frame } from "../../../packages/oar/src/contracts/records.js";
import { eventsOf } from "../../../packages/oar/src/observe/events.js";
import { createSessionKernel } from "../../../packages/oar/src/shared/session-kernel.js";

const thread = {
  id: "t1",
  title: "t",
  model: "m",
  reasoning_effort: "low",
  context_tokens: 5,
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cached_tokens: 0 },
  status: "idle",
  display_status: "ready",
  created_at: 1,
  updated_at: 1,
};

interface Deployment {
  status: string;
  display: string;
  history: unknown[];
  /** When set, every read fails the way a transport error does. */
  offline: boolean;
}

/** A deployment the test mutates between polls, plus the gate that releases one poll at a time. */
function harness(initial: Deployment) {
  const state: Deployment = { ...initial };
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    if (state.offline) {
      throw new Error("network unreachable");
    }
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (path.endsWith("/history")) {
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
    thread: { native: thread, id: "t1", status: "idle", displayStatus: "ready", title: "t", model: "m", effort: "low", contextTokens: 5, usage: { input: 1, output: 1, cacheRead: 0 } },
    seen: 0,
    onIdle: () => undefined,
    wait: async () => await new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  const events = (): Event[] => kernel.records().flatMap((record) => (record.kind === "frame" ? eventsOf(record as Frame) : []));
  const ends = (): Event[] => events().filter((event) => event.kind === "turn_ended");
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
        // The turn ended, so no further poll is coming.
        return;
      }
    }
    throw new Error("the tracker never asked for another poll");
  };
  return { state, kernel, tracker, events, ends, nextPoll };
}

const input = (id: number, content: string) => ({ id, thread_id: "t1", kind: "input", payload: { role: "user", content }, created_at: id });
const message = (id: number, text: string) => ({ id, thread_id: "t1", kind: "response_output", payload: { type: "message", id: `m${String(id)}`, role: "assistant", content: [{ type: "output_text", text }] }, created_at: id });

describe("a cybion turn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not end before the Thread runs, even though the input record is already there", async () => {
    const bed = harness({ status: "idle", display: "ready", history: [input(1, "hi")], offline: false });
    bed.tracker.follow(1);
    // The Thread sits idle, waiting for a Worker: the input is recorded but nothing ran.
    for (let poll = 0; poll < 5; poll += 1) {
      await bed.nextPoll();
    }
    expect(bed.ends()).toEqual([]);
    expect(bed.events().some((event) => event.kind === "user_message")).toBe(true);

    bed.state.status = "running";
    bed.state.display = "running";
    await bed.nextPoll();
    bed.state.history.push(message(2, "hello"));
    bed.state.status = "idle";
    bed.state.display = "completed";
    await bed.nextPoll();
    await bed.nextPoll();
    expect(bed.ends()).toHaveLength(1);
    expect(bed.ends()[0]).toMatchObject({ outcome: { kind: "completed" } });
    bed.tracker.close();
  });

  it("frames records written between two turns instead of skipping them", async () => {
    // Record 1 was written after the previous turn ended; the new input is record 2.
    const bed = harness({ status: "idle", display: "ready", history: [message(1, "late output"), input(2, "next")], offline: false });
    bed.tracker.follow(2);
    await bed.nextPoll();
    const frames = bed.kernel.records().filter((record) => record.kind === "frame").map((record) => record.body.type);
    expect(frames).toContain("history/response_output/message");
    expect(frames).toContain("history/input");
    // The between-turns record is in the stream but is not this turn's work.
    expect(bed.ends()).toEqual([]);
    bed.tracker.close();
  });

  it("fails one turn when the deployment stops answering, without claiming a process exited", async () => {
    const bed = harness({ status: "running", display: "running", history: [input(1, "hi")], offline: false });
    bed.tracker.follow(1);
    await bed.nextPoll();
    bed.state.offline = true;
    for (let poll = 0; poll < 9; poll += 1) {
      await bed.nextPoll();
    }
    expect(bed.ends()).toHaveLength(1);
    expect(bed.ends()[0]).toMatchObject({ outcome: { kind: "failed", failure: "unknown" } });
    // Nothing exited, so the session is still usable and no exit was recorded.
    expect(bed.events().some((event) => event.kind === "exited")).toBe(false);
    expect(bed.kernel.unreachable()).toBeNull();
    bed.tracker.close();
  });
});
