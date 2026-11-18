import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event } from "../../../packages/oar/src/contracts/records.js";
import { createCybionRuntime } from "../../../packages/oar/src/community/cybion/index.js";
import type { Session } from "../../../packages/oar/src/contracts/session.js";

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

/**
 * A deployment that answers one turn: the input record lands at once, the
 * message after the first history read, and the Thread runs for two reads
 * before it goes idle with the turn's settled totals.
 */
function scriptedDeployment(): { fetch: typeof globalThis.fetch; polls: () => number } {
  let historyReads = 0;
  let threadReads = 0;
  const history: unknown[] = [];
  const view = (running: boolean): unknown => ({
    ...thread,
    status: running ? "running" : "idle",
    display_status: running ? "running" : "completed",
    context_tokens: running ? 12 : 20,
    usage: {
      ...thread.usage,
      input_tokens: running ? 10 : 20,
      output_tokens: running ? 3 : 7,
      total_tokens: running ? 13 : 27,
    },
  });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && url.pathname === "/v1/threads") {
      return json(thread);
    }
    if (method === "POST" && url.pathname === "/v1/threads/t1/inputs") {
      const body = JSON.parse(String(init?.body)) as { input: string };
      history.push({ id: 1, thread_id: "t1", kind: "input", payload: { role: "user", content: body.input }, created_at: 2 });
      return json({ thread_id: "t1", record_idx: 1, status: "queued" });
    }
    if (method === "GET" && url.pathname === "/v1/threads/t1/history") {
      historyReads += 1;
      if (historyReads === 2 && history.length === 1) {
        history.push({
          id: 2,
          thread_id: "t1",
          kind: "response_output",
          payload: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
          created_at: 3,
        });
      }
      return json([...history]);
    }
    if (method === "GET" && url.pathname === "/v1/threads/t1") {
      threadReads += 1;
      return json(view(threadReads <= 2));
    }
    return json({ error: `unscripted ${method} ${url.pathname}` }, 500);
  };
  return { fetch: fetch as typeof globalThis.fetch, polls: () => historyReads };
}

async function drive(session: Session, run: () => Promise<void>): Promise<Event[]> {
  const seen: Event[] = [];
  session.events((event) => seen.push(event));
  await run();
  return seen;
}

describe("the cybion runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares a bundled installation and the options a Thread cannot take", async () => {
    vi.stubGlobal("fetch", scriptedDeployment().fetch);
    const runtime = createCybionRuntime({ baseUrl: "https://cybion.test", apiKey: "cyb_me_secret" });
    const installation = await runtime.installation?.();
    expect(installation).toEqual({ kind: "available", via: "bundled" });
    expect(runtime.sessionCapabilities?.({ kind: "available", via: "bundled" })).toEqual({ steer: false, images: true });
    expect(runtime.refusedSessionOptions?.systemPrompt).toBeDefined();
  });

  it("runs one turn: the Thread's own records become events and the Thread's status ends it", async () => {
    vi.stubGlobal("fetch", scriptedDeployment().fetch);
    const runtime = createCybionRuntime({ baseUrl: "https://cybion.test", apiKey: "cyb_me_secret" });
    const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: "/work" });
    expect(session.id).toBe("t1");
    expect(session.steer).toBeUndefined();

    const events = await drive(session, async () => {
      const outcome = await session.prompt("hi");
      expect(outcome.kind).toBe("accepted");
      const status = await session.status();
      expect(status.value.kind).toBe("running");
      for (let index = 0; index < 80 && session.status().value.kind === "running"; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });

    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("turn_started");
    expect(kinds).toContain("user_message");
    expect(kinds).toContain("text_delta");
    expect(kinds).toContain("turn_ended");
    expect(events.find((event) => event.kind === "text_delta")).toMatchObject({ text: "hello" });
    expect(events.find((event) => event.kind === "turn_ended")).toMatchObject({ outcome: { kind: "completed" } });
    expect(session.status().value.kind).toBe("idle");
    expect(session.usage().value.total).toMatchObject({ input: 20, output: 7 });
    await session.dispose();
  }, 15_000);

  it("answers no_active_turn when nothing runs, and cancels the Thread when something does", async () => {
    vi.stubGlobal("fetch", scriptedDeployment().fetch);
    const runtime = createCybionRuntime({ baseUrl: "https://cybion.test", apiKey: "cyb_me_secret" });
    const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: "/work" });
    // Nothing followed yet: no cancel is sent, and the caller owns the decision.
    const idle = await session.abort();
    expect(idle).toMatchObject({ kind: "rejected", code: "no_active_turn" });
    await session.dispose();
  }, 15_000);
});
