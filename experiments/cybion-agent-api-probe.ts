/**
 * What Cybion's Agent API actually carries for one Thread, driven through this
 * repository's own adapter (`createCybionRuntime`), over real HTTP.
 *
 * Two probes:
 *
 * 1. **Wire probe** (no credentials): a local HTTP server speaking the Agent
 *    API shapes (`/v1/threads`, `/{id}`, `/{id}/history`, `/{id}/inputs`), so
 *    the client, the polling tracker and the session run over a socket rather
 *    than a stubbed `fetch`. Prints what the adapter sent and what the
 *    session reported.
 * 2. **Live probe** (needs a deployment): with `CYBION_BASE_URL` and
 *    `CYBION_API_KEY` (`cyb_<user id>_<secret>`), one real turn on a real
 *    Thread. Without them it prints the refusal a bogus key gets from the real
 *    deployment when `CYBION_BASE_URL` is set, which is what this repository
 *    has actually observed so far.
 *
 *   pnpm tsx experiments/cybion-agent-api-probe.ts
 *   CYBION_BASE_URL=https://cybion.ntnl.io CYBION_API_KEY=cyb_... pnpm tsx experiments/cybion-agent-api-probe.ts
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createCybionRuntime } from "../packages/oar/src/community/cybion/index.js";
import type { Event } from "../packages/oar/src/contracts/records.js";

const thread = {
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
  created_at: Date.now(),
  updated_at: Date.now(),
};

interface Observed {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** A server that answers the Agent API shapes and records what arrived. */
async function wireProbe(): Promise<void> {
  const arrived: Observed[] = [];
  const history: unknown[] = [];
  let statusReads = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body: unknown = raw === "" ? null : JSON.parse(raw);
      arrived.push({ method: request.method ?? "", path: request.url ?? "", authorization: request.headers.authorization, body });
      const reply = (payload: unknown): void => {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
      };
      const path = request.url ?? "";
      if (request.method === "POST" && path === "/v1/threads") {
        reply(thread);
        return;
      }
      if (request.method === "POST" && path.endsWith("/inputs")) {
        const input = (body as { input: string }).input;
        history.push({ id: 1, thread_id: thread.id, kind: "input", payload: { role: "user", content: input }, created_at: Date.now() });
        reply({ thread_id: thread.id, record_idx: 1, status: "queued" });
        return;
      }
      if (request.method === "GET" && path.endsWith("/history")) {
        if (history.length === 1) {
          history.push({
            id: 2,
            thread_id: thread.id,
            kind: "response_output",
            payload: { type: "message", id: "msg_probe", role: "assistant", content: [{ type: "output_text", text: "probe answer" }] },
            created_at: Date.now(),
          });
          history.push({ id: 3, thread_id: thread.id, kind: "tool_output", payload: { call_id: "call_probe", output: "ok" }, created_at: Date.now() });
        }
        reply([...history]);
        return;
      }
      if (request.method === "GET" && path === `/v1/threads/${thread.id}`) {
        statusReads += 1;
        const running = statusReads === 1;
        reply({
          ...thread,
          status: running ? "running" : "idle",
          display_status: running ? "running" : "completed",
          context_tokens: running ? 11 : 23,
          usage: { ...thread.usage, input_tokens: running ? 10 : 21, output_tokens: running ? 2 : 6, total_tokens: running ? 12 : 27 },
        });
        return;
      }
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: `unscripted ${request.method ?? ""} ${path}` }));
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const { port } = server.address() as AddressInfo;

  const runtime = createCybionRuntime({ baseUrl: `http://127.0.0.1:${String(port)}`, apiKey: "cyb_probe_secret" });
  const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: process.cwd(), name: "probe" });
  const seen: Event[] = [];
  session.events((event) => seen.push(event));
  const prompt = await session.prompt("hello there");
  for (let index = 0; index < 120 && session.status().value.kind === "running"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const usage = session.usage().value;
  await session.dispose();
  server.close();

  console.log("── wire probe: what the adapter sent ──");
  for (const call of arrived) {
    console.log(`${call.method} ${call.path}  authorization=${call.authorization ?? "none"}  body=${JSON.stringify(call.body)}`);
  }
  console.log("── wire probe: what the session reported ──");
  console.log(`session id           ${session.id}`);
  console.log(`prompt outcome       ${prompt.kind}`);
  console.log(`status               ${session.status().value.kind}`);
  console.log(`events               ${seen.map((event) => event.kind).join(", ")}`);
  console.log(`text                 ${JSON.stringify(seen.filter((event) => event.kind === "text_delta").map((event) => event.text).join(""))}`);
  console.log(`turn outcome         ${JSON.stringify(seen.find((event) => event.kind === "turn_ended")?.kind === "turn_ended" ? seen.find((event) => event.kind === "turn_ended") : null)}`);
  console.log(`usage total          ${JSON.stringify(usage.total)}`);
  console.log(`context usage        ${JSON.stringify(session.contextUsage().value)}`);
}

/** The live probe: one real turn when credentials are given, otherwise the refusal a bogus key gets. */
async function liveProbe(baseUrl: string, apiKey: string | undefined): Promise<void> {
  console.log(`── live probe: ${baseUrl} ──`);
  const key = apiKey ?? "cyb_00000000-0000-0000-0000-000000000000_probe";
  const runtime = createCybionRuntime({ baseUrl, apiKey: key });
  try {
    const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: process.cwd(), name: "oar probe" });
    const seen: Event[] = [];
    session.events((event) => seen.push(event));
    await session.prompt("Reply with the single word: pong. Do not use tools.");
    for (let index = 0; index < 600 && session.status().value.kind === "running"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.log(`session id           ${session.id}`);
    console.log(`status               ${session.status().value.kind}`);
    console.log(`text                 ${JSON.stringify(seen.filter((event) => event.kind === "text_delta").map((event) => event.text).join(""))}`);
    console.log(`usage total          ${JSON.stringify(session.usage().value.total)}`);
    await session.dispose();
  } catch (error) {
    console.log(`refused              ${error instanceof Error ? error.message : String(error)}`);
  }
}

await wireProbe();
const baseUrl = process.env.CYBION_BASE_URL;
if (baseUrl !== undefined) {
  await liveProbe(baseUrl, process.env.CYBION_API_KEY);
} else {
  console.log("(no CYBION_BASE_URL: live probe skipped)");
}
