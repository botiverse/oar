import { afterEach, describe, expect, it, vi } from "vitest";
import { createCybionRuntime } from "../../../packages/oar/src/community/cybion/index.js";
import type { Event } from "../../../packages/oar/src/contracts/records.js";
import type { Session } from "../../../packages/oar/src/contracts/session.js";

const base = {
  id: "t1",
  title: "t",
  model: "m",
  reasoning_effort: "low",
  context_tokens: 5,
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cached_tokens: 0 },
  created_at: 1,
  updated_at: 1,
};

/**
 * A Thread that answers one turn per input: `running` for the two reads after
 * an input, then `completed`. `refuseFrom` makes the Thread refuse the n-th
 * input with a 400, the way an over-long or unsupported input is refused.
 */
function deployment(refuseFrom: number | null) {
  const history: Record<string, unknown>[] = [];
  const inputs: { input: string; images?: string[] }[] = [];
  const headers: (string | undefined)[] = [];
  let readsSinceInput = 0;
  let cancelled = false;
  let nextId = 1;

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    headers.push(new Headers(init?.headers).get("authorization") ?? undefined);
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && url.pathname === "/v1/threads") {
      return json({ ...base, status: "idle", display_status: "ready" });
    }
    if (method === "POST" && url.pathname === "/v1/threads/t1/inputs") {
      const body = JSON.parse(String(init?.body)) as { input: string; images?: string[] };
      if (refuseFrom !== null && inputs.length + 1 >= refuseFrom) {
        return json({ error: "input must contain 1-100000 characters" }, 400);
      }
      inputs.push(body);
      readsSinceInput = 0;
      const id = nextId;
      nextId += 1;
      history.push({ id, thread_id: "t1", kind: "input", payload: { role: "user", content: body.input }, created_at: id });
      return json({ thread_id: "t1", record_idx: id, status: "queued" });
    }
    if (method === "POST" && url.pathname === "/api/threads/t1/cancel") {
      cancelled = true;
      return json({ ...base, status: "idle", display_status: "stopped" });
    }
    if (method === "GET" && url.pathname === "/v1/threads/t1/history") {
      return json([...history]);
    }
    if (method === "GET" && url.pathname === "/v1/threads/t1") {
      readsSinceInput += 1;
      const running = !cancelled && readsSinceInput <= 2;
      if (readsSinceInput === 2 && history.length > 0) {
        const id = nextId;
        nextId += 1;
        history.push({ id, thread_id: "t1", kind: "response_output", payload: { type: "message", id: `m${String(id)}`, role: "assistant", content: [{ type: "output_text", text: `answer ${String(inputs.length)}` }] }, created_at: id });
      }
      return json({ ...base, status: running ? "running" : "idle", display_status: running ? "running" : cancelled ? "stopped" : "completed" });
    }
    return json({ error: `unscripted ${method} ${url.pathname}` }, 404);
  };
  return { fetch, inputs, history, headers };
}

async function until(condition: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition not reached in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function open(): Promise<{ session: Session; events: Event[] }> {
  const runtime = createCybionRuntime({ baseUrl: "https://cybion.test", apiKey: "cyb_me_secret" });
  const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: "/work" });
  const events: Event[] = [];
  session.events((event) => events.push(event));
  return { session, events };
}

describe("a queued cybion input", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is dispatched as a prompt of its own, so its turn is in the stream", async () => {
    const bed = deployment(null);
    vi.stubGlobal("fetch", bed.fetch);
    const { session, events } = await open();

    const first = await session.prompt("first");
    expect(first.kind).toBe("accepted");
    const queued = await session.queue("second");
    expect(queued.kind).toBe("accepted");
    // A held input keeps the session busy: a prompt cannot overtake it.
    expect(session.status().value.kind).toBe("running");
    expect((await session.prompt("overtake")).kind).toBe("rejected");

    await until(() => bed.inputs.length === 2);
    await until(() => session.status().value.kind === "idle");

    expect(bed.inputs.map((entry) => entry.input)).toEqual(["first", "second"]);
    // A rejected prompt is still a recorded turn start, so count the inputs that ran.
    const starts = events.flatMap((event) => (event.kind === "turn_started" ? [event.input] : []));
    expect(starts.filter((input) => input === "second")).toHaveLength(1);
    // The dispatch is a prompt of its own, carrying the held input's identity.
    const dispatch = session.records().find((record) => record.kind === "request" && record.body.kind === "prompt" && record.body.input === "second");
    expect(dispatch?.body).toMatchObject({ kind: "prompt", carries: [expect.any(String) as string] });
    expect(dispatch?.body.kind === "prompt" ? dispatch.body.inputId : undefined).not.toBe((dispatch?.body.kind === "prompt" ? dispatch.body.carries?.[0] : undefined));
    // The key never reaches a record.
    expect(JSON.stringify(session.records())).not.toContain("cyb_me_secret");
    await session.dispose();
  }, 30_000);

  it("is handed back as input_dropped when the Thread refuses it", async () => {
    const bed = deployment(2);
    vi.stubGlobal("fetch", bed.fetch);
    const { session, events } = await open();

    await session.prompt("first");
    await session.queue("second");
    await until(() => events.some((event) => event.kind === "input_dropped"));
    await until(() => session.status().value.kind === "idle");

    const dropped = events.find((event) => event.kind === "input_dropped");
    expect(dropped).toMatchObject({ reason: "runtime_refused" });
    expect(bed.inputs.map((entry) => entry.input)).toEqual(["first"]);
    await session.dispose();
  }, 30_000);

  it("aborts a running turn through Cybion's own cancel route", async () => {
    const bed = deployment(null);
    vi.stubGlobal("fetch", bed.fetch);
    const { session, events } = await open();

    await session.prompt("first");
    await until(() => session.status().value.kind === "running");
    const abort = await session.abort();
    expect(abort.kind).toBe("accepted");
    await until(() => session.status().value.kind === "idle");
    expect(events.find((event) => event.kind === "turn_ended")).toMatchObject({ outcome: { kind: "aborted" } });
    await session.dispose();
  }, 30_000);
});
