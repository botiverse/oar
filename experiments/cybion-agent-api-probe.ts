/**
 * What Cybion's Agent API actually carries for one Thread, driven through this
 * repository's own adapter (`createCybionRuntime`), over real HTTP.
 *
 * Two probes:
 *
 * 1. **Wire probe** (no credentials): a local HTTP server speaking the Agent
 *    API shapes (`/v1/threads`, `/{id}`, `/{id}/history`, `/{id}/inputs`), so
 *    the client, the polling tracker and the session run over a socket rather
 *    than a stubbed `fetch`. Prints what the adapter sent and what the session
 *    reported.
 * 2. **Live probe** (needs a deployment): with `CYBION_BASE_URL` and
 *    `CYBION_API_KEY` (`cyb_<user id>_<secret>`), real turns on a real Thread:
 *    one that calls a tool, one input queued while that turn runs, and a
 *    resumed session on the same Thread.
 *
 *   pnpm tsx experiments/cybion-agent-api-probe.ts
 *   CYBION_BASE_URL=https://cybion.ntnl.io CYBION_API_KEY=cyb_... pnpm tsx experiments/cybion-agent-api-probe.ts
 *
 * OBSERVED (2026-11-18, Cybion 0.6.108 at cybion.ntnl.io): a tool-calling turn
 * reported `reasoning`, `tool_call_started` / `tool_call_ended` pairs and the
 * tool's own output as the answer; an input queued while a turn ran was
 * dispatched as a prompt of its own (three inputs, three `turn_started`); a
 * resumed session reported the same Thread id, model and effort.
 */
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createCybionRuntime } from "../packages/oar/src/community/cybion/index.js";
import type { Event } from "../packages/oar/src/contracts/records.js";
import { asRecord, parseJson, type JsonRecord } from "../packages/oar/src/shared/json.js";

const SLICE_MS = 100;
const TURN_BUDGET_MS = 240_000;

const thread: JsonRecord = {
  id: "probe-thread",
  purpose: "chat",
  created_by: "api",
  external_ref: null,
  title: "probe",
  model: "probe-model",
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

interface Observed {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** Wait out `budgetMs` in slices until `check()` holds; recursion keeps it out of a loop. */
async function waitFor(check: () => boolean, budgetMs: number, why: string): Promise<void> {
  if (check()) {
    return;
  }
  if (budgetMs <= 0) {
    throw new Error(why);
  }
  await delay(SLICE_MS);
  await waitFor(check, budgetMs - SLICE_MS, why);
}

const kindsOf = (events: readonly Event[]): string => {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, count]) => `${kind}\u00D7${String(count)}`).join(" ");
};

const textOf = (events: readonly Event[]): string => events.flatMap((event) => (event.kind === "text_delta" ? [event.text] : [])).join("");

/** A server that answers the Agent API shapes and records what arrived. */
async function wireProbe(): Promise<void> {
  const arrived: Observed[] = [];
  const history: JsonRecord[] = [];
  let statusReads = 0;
  const record = (id: number, kind: string, payload: JsonRecord): JsonRecord => {
    const entry = { id, thread_id: "probe-thread", kind, payload, created_at: id };
    history.push(entry);
    return entry;
  };
  const answer = (method: string, path: string, body: unknown): unknown => {
    if (method === "POST" && path === "/v1/threads") {
      return thread;
    }
    if (method === "POST" && path.endsWith("/inputs")) {
      const input = asRecord(body)?.input;
      const entry = record(history.length + 1, "input", { role: "user", content: typeof input === "string" ? input : "" });
      return { thread_id: "probe-thread", record_idx: entry.id, status: "queued" };
    }
    if (method === "GET" && path.endsWith("/history")) {
      if (history.length === 1) {
        record(2, "response_output", { type: "message", id: "msg_probe", role: "assistant", content: [{ type: "output_text", text: "probe answer" }] });
        record(3, "tool_output", { call_id: "call_probe", output: "ok" });
      }
      return [...history];
    }
    if (method === "GET" && path === "/v1/threads/probe-thread") {
      statusReads += 1;
      const running = statusReads === 1;
      return {
        ...thread,
        status: running ? "running" : "idle",
        display_status: running ? "running" : "completed",
        context_tokens: running ? 11 : 23,
        usage: { ...asRecord(thread.usage), input_tokens: running ? 10 : 21, output_tokens: running ? 2 : 6, total_tokens: running ? 12 : 27 },
      };
    }
    return null;
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const method = request.method ?? "";
      const path = request.url ?? "";
      const body = raw === "" ? null : parseJson(raw);
      arrived.push({ method, path, authorization: request.headers.authorization, body });
      const payload = JSON.stringify(answer(method, path, body));
      response.writeHead(200, { "content-type": "application/json" }).end(payload);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => {
    listening.resolve();
  });
  await listening.promise;
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;

  const runtime = createCybionRuntime({ baseUrl: `http://127.0.0.1:${String(port)}`, apiKey: "cyb_probe_secret" });
  const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: process.cwd(), name: "probe" });
  const seen: Event[] = [];
  session.events((event) => {
    seen.push(event);
  });
  const prompt = await session.prompt("hello there");
  await waitFor(() => session.status().value.kind === "idle", TURN_BUDGET_MS, "the wire probe's turn never ended");
  const usage = session.usage().value;
  const context = session.contextUsage().value;
  await session.dispose();
  server.close();

  console.log("\u2500\u2500 wire probe: what the adapter sent \u2500\u2500");
  for (const call of arrived) {
    console.log(`${call.method} ${call.path}  authorization=${call.authorization ?? "none"}  body=${JSON.stringify(call.body)}`);
  }
  console.log("\u2500\u2500 wire probe: what the session reported \u2500\u2500");
  console.log(`session id           ${session.id}`);
  console.log(`prompt outcome       ${prompt.kind}`);
  console.log(`status               ${session.status().value.kind}`);
  console.log(`events               ${kindsOf(seen)}`);
  console.log(`text                 ${JSON.stringify(textOf(seen))}`);
  console.log(`usage total          ${JSON.stringify(usage.total)}`);
  console.log(`context usage        ${JSON.stringify(context)}`);
}

/** One real turn with a tool call, one queued input, and a resume of the same Thread. */
async function liveProbe(baseUrl: string, apiKey: string): Promise<void> {
  const runtime = createCybionRuntime({ baseUrl, apiKey });
  const installation = { kind: "available", via: "bundled" } as const;
  const first = await runtime.session(installation, { cwd: process.cwd(), name: "oar live probe" });
  const events: Event[] = [];
  first.events((event) => {
    events.push(event);
  });
  console.log(`\u2500\u2500 live probe: ${baseUrl} \u2500\u2500`);
  console.log(`thread ${first.id} model=${String(first.model().value)} effort=${String(first.effort().value)}`);

  await first.prompt("Use the bash tool to run exactly `echo oar-probe-tool` on my device, then reply with its output only.");
  await waitFor(() => first.status().value.kind === "idle", TURN_BUDGET_MS, "the tool-calling turn never ended");
  console.log(`tool turn            ${kindsOf(events)}`);
  console.log(`tool turn text       ${JSON.stringify(textOf(events).slice(0, 120))}`);

  await first.prompt("List the files in the current directory with the bash tool, then summarise them in one line.");
  const queued = await first.queue("Finally, reply with the single word: pong.");
  console.log(`queue                ${queued.kind} status=${first.status().value.kind}`);
  await waitFor(() => first.status().value.kind === "idle" && events.filter((event) => event.kind === "turn_started").length >= 3, TURN_BUDGET_MS, "the queued turn never ran");
  await waitFor(() => first.status().value.kind === "idle", TURN_BUDGET_MS, "the queued turn never ended");
  console.log(`three turns          ${kindsOf(events)}`);
  console.log(`last text            ${JSON.stringify(textOf(events).slice(-120))}`);
  console.log(`usage                ${JSON.stringify(first.usage().value.total)}`);
  await first.dispose();

  const resumed = await runtime.session(installation, { cwd: process.cwd(), resume: first.id });
  const resumedEvents: Event[] = [];
  resumed.events((event) => {
    resumedEvents.push(event);
  });
  console.log(`resumed              same=${String(resumed.id === first.id)} model=${String(resumed.model().value)} effort=${String(resumed.effort().value)}`);
  await resumed.prompt("What word did you just say? Reply with that single word and nothing else.");
  await waitFor(() => resumed.status().value.kind === "idle", TURN_BUDGET_MS, "the resumed turn never ended");
  console.log(`resume turn          ${kindsOf(resumedEvents)}`);
  console.log(`resume text          ${JSON.stringify(textOf(resumedEvents).slice(0, 120))}`);
  await resumed.dispose();
}

await wireProbe();
const baseUrl = process.env.CYBION_BASE_URL;
const apiKey = process.env.CYBION_API_KEY;
if (baseUrl !== undefined && apiKey !== undefined) {
  await liveProbe(baseUrl, apiKey);
} else {
  console.log("(no CYBION_BASE_URL / CYBION_API_KEY: live probe skipped)");
}
