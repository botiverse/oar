/**
 * FIRST CONTACT WITH THE OPENAI AGENTS API (public beta, 2026-09-10).
 *
 * Reference-only runtime today (docs/runtimes/agents-api.md). This script
 * exists so that an adapter, if one is written, is built on observations
 * rather than on the vendor's documentation. It answers the eight questions
 * that page lists, in the order they block design decisions:
 *
 *   Q1 steer detection: does a message during an active root turn produce a
 *      second `agent.session.turn.created`, or none?
 *   Q2 typed rejection: does a cancel on an idle session return 4xx or 2xx?
 *   Q3 attribution order: does `turn.created` for a subagent turn precede
 *      that turn's item events (local turn_id -> subagent_id is then enough)?
 *   Q4 child text: do subagent `output_text.delta` events ride the root
 *      stream, or only coordination items and turn lifecycle?
 *   Q5 cursor: does the SSE carry `id:` lines; is `event_id` orderable?
 *   Q6 usage: how often is `usage` null on `turn.completed`, and does a
 *      later turn retrieve differ from the event?
 *   Q7 model: what does `session.agent.model` report when `agent.model` is
 *      omitted (or is omission rejected)?
 *   Q8 delete: does DELETE end an open stream with an event, an `error`,
 *      or a bare disconnect?
 *
 * ⚠️ NO SDK, NO REPO MACHINERY. Plain `fetch` + a hand-rolled SSE reader:
 * the claim worth making is "someone without our kernel can drive this
 * runtime", so nothing from packages/ is imported.
 *
 * Run: OPENAI_API_KEY=... pnpm tsx experiments/agents-api-probe.ts [--model gpt-6-astra] [--keep]
 *   The key needs api.agents.read + api.agents.write + api.responses.write.
 *   Uses environment {type: "none"}: no sandbox is billed, only tokens.
 *   Writes every observed event to oar-trial-run/agents-api-<stamp>/events.jsonl
 *   and the answers to findings.json. `--keep` skips the final DELETE (and Q8).
 *
 * ── OBSERVED 2026-09-12, gpt-6-astra, environment none, 2 runs (macOS, via ──
 *    NODE_USE_ENV_PROXY=1 because Node's fetch ignores the shell proxy) ──────
 *
 * Q1 ⭐ a message POSTed mid-turn (after the first text delta of a 40-line
 *    count) did NOT steer: the count ran to 40, the turn completed, and the
 *    message ran as the NEXT turn (its own turn.created, item, completed).
 *    Both POSTs answered 202 with an empty body. Caveat: a single-generation
 *    turn with no tool boundary; steering may need a step boundary to land.
 *    On the wire this is queue semantics with no queue acknowledgement.
 * Q2 cancel on an idle session: 202, empty body, no event. Not a typed
 *    rejection. (3 observations.)
 * Q3 no subagent turn event of any kind reaches the root stream: every
 *    turn.created/completed seen had subagent_id null. The subagent's turn
 *    exists only under /sessions/{id}/subagents/{sid}/turns (with usage) and
 *    its items under .../subagents/{sid}/items; the session-level turns
 *    list holds root turns only.
 * Q4 zero subagent text deltas on the root stream. What does arrive:
 *    subagent.created (twice, second copy with instructions filled),
 *    subagent.closed, and the coordination items (create_subagent_call,
 *    agent_message both directions with sender/recipient_agent_id,
 *    wait_for_subagents_call, close_subagent_call). ⚠️ They arrive as a
 *    burst AFTER subagent.closed, 7 s after subagent.created: the stream
 *    order is not causal order (closed before the create item was added).
 * Q5 no SSE `id:` lines; event_id is random (not lexically ordered). There
 *    is nothing to resume from.
 * Q6 `usage` was null on EVERY terminal turn event (8/8). Retrieved turns
 *    had usage for some turns and null for others, and which ones changed
 *    between reads seconds apart; the session's own usage read null after
 *    four completed turns. Usage is a late, eventually-filled field.
 * Q7 omitting agent.model is a 400 "agent.model is required when agent_id
 *    is omitted"; with a model given, session.agent.model echoes it.
 * Q8 DELETE returns 200 and the open stream ends with a clean EOF: no
 *    event, no `error`, no stream-level notice.
 *
 * Other: create with stream:true returns the first turn's events and then
 * EOF after agent.session.idle; a separate GET stream is needed for later
 * turns. agent.session.created, .in_progress and .idle each carry the full
 * session object. Text arrives token by token as output_text.delta.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const BASE = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const KEY = process.env.OPENAI_API_KEY;
if (KEY === undefined || KEY === "") {
  throw new Error("OPENAI_API_KEY is required (an api.agents.* project key)");
}
const args = process.argv.slice(2);
const modelArg: string | undefined = args.includes("--model") ? args[args.indexOf("--model") + 1] : undefined;
const keep = args.includes("--keep");
const FALLBACK_MODEL = "gpt-6-astra";
const TURN_TIMEOUT_MS = 180_000;

const headers = {
  Authorization: `Bearer ${KEY}`,
  "OpenAI-Beta": "agents=v1",
  "Content-Type": "application/json",
};

// ─── observation log ───────────────────────────────────────────────────────

type Json = Record<string, unknown>;
interface Observed {
  readonly n: number;
  readonly at: number;
  readonly source: "create-stream" | "session-stream";
  readonly sseId: string | null;
  readonly event: Json;
}
const observed: Observed[] = [];
const findings: Json = {};
const waiters = new Set<(o: Observed) => void>();

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null;
}
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function field(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const key of keys) {
    if (!isRecord(cur)) {
      return undefined;
    }
    cur = cur[key];
  }
  return cur;
}
function note(o: Observed): void {
  observed.push(o);
  const type = str(o.event.type) ?? "?";
  const turn = str(o.event.turn_id) ?? str(field(o.event, "turn", "id"));
  const sub = field(o.event, "turn", "subagent_id");
  const delta = str(o.event.delta);
  const turnTag = turn === null ? "" : ` turn=${turn}`;
  const subTag = typeof sub === "string" ? ` sub=${sub}` : "";
  const deltaTag = delta === null ? "" : ` ${JSON.stringify(delta.slice(0, 30))}`;
  process.stdout.write(`${o.n} ${o.source === "create-stream" ? "C" : "S"} ${type}${turnTag}${subTag}${deltaTag}\n`);
  for (const w of waiters) {
    w(o);
  }
}
async function waitFor(pred: (o: Observed) => boolean, what: string, ms = TURN_TIMEOUT_MS): Promise<Observed> {
  const already = observed.find((o) => pred(o));
  if (already !== undefined) {
    return already;
  }
  const { promise, resolve, reject } = Promise.withResolvers<Observed>();
  const timer = setTimeout(() => {
    waiters.delete(w);
    reject(new Error(`timeout waiting for ${what}`));
  }, ms);
  const w = (o: Observed): void => {
    if (pred(o)) {
      clearTimeout(timer);
      waiters.delete(w);
      resolve(o);
    }
  };
  waiters.add(w);
  const found = await promise;
  return found;
}

const ROOT_TERMINAL = new Set(["agent.session.turn.completed", "agent.session.turn.failed", "agent.session.turn.cancelled"]);
const isRootTerminal = (o: Observed): boolean =>
  ROOT_TERMINAL.has(str(o.event.type) ?? "") && field(o.event, "turn", "subagent_id") === null;

// ─── SSE reader ────────────────────────────────────────────────────────────

let counter = 0;
/** Reads one SSE body to its end; resolves with how the stream ended. */
async function readSse(res: Response, source: Observed["source"]): Promise<"eof" | "abort"> {
  if (res.body === null) {
    throw new Error(`${source}: no body`);
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (frame: string): void => {
    let data = "";
    let sseId: string | null = null;
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      } else if (line.startsWith("id:")) {
        sseId = line.slice(3).trim();
      }
    }
    if (data === "" || data === "[DONE]") {
      return;
    }
    const parsed: unknown = parseJson(data);
    counter += 1;
    note({ n: counter, at: Date.now(), source, sseId, event: isRecord(parsed) ? parsed : { type: "<non-object>", raw: parsed } });
  };
  try {
    const chunks: AsyncIterable<Uint8Array> = res.body;
    for await (const chunk of chunks) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx >= 0) {
        flush(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim() !== "") {
      flush(buffer);
    }
    return "eof";
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return "abort";
    }
    throw error;
  }
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return { type: "<unparseable>", raw: data };
  }
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

async function post(url: string, body: Json): Promise<Response> {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  return res;
}
async function postEvents(sessionId: string, events: Json[]): Promise<{ status: number; body: string }> {
  const res = await post(`${BASE}/agents/sessions/${sessionId}/events`, { events });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 500) };
}
const message = (text: string): Json => ({
  type: "agent.session.input.message",
  input: [{ role: "user", content: [{ type: "input_text", text }] }],
});
async function getJson(url: string): Promise<Json> {
  const res = await fetch(url, { headers });
  const body: unknown = await res.json();
  return isRecord(body) ? body : { raw: body };
}

// ─── the probe ─────────────────────────────────────────────────────────────

const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
const outDir = path.join(process.cwd(), "oar-trial-run", `agents-api-${stamp}`);
await mkdir(outDir, { recursive: true });

// Step 1: create + stream the first turn. Q7: omit the model unless asked.
const agent: Json = {
  instructions: "You are a probe target. Follow instructions literally and briefly.",
  multi_agent: { enabled: true, max_concurrent_subagents: 1 },
  ...(modelArg === undefined ? {} : { model: modelArg }),
};
let createRes = await post(`${BASE}/agents/sessions`, {
  agent,
  environment: { type: "none" },
  input: "Reply with the single word READY.",
  stream: true,
});
if (!createRes.ok && modelArg === undefined) {
  const rejection = await createRes.text();
  findings.q7_omitted_model_rejected = { status: createRes.status, body: rejection.slice(0, 500) };
  agent.model = FALLBACK_MODEL;
  createRes = await post(`${BASE}/agents/sessions`, { agent, environment: { type: "none" }, input: "Reply with the single word READY.", stream: true });
}
if (!createRes.ok) {
  const failure = await createRes.text();
  throw new Error(`create failed: ${createRes.status} ${failure}`);
}
const createDone = readSse(createRes, "create-stream");
const created = await waitFor((o) => o.event.type === "agent.session.created", "agent.session.created", 60_000);
const sessionId = str(field(created.event, "session", "id"));
if (sessionId === null) {
  throw new Error("no session id on agent.session.created");
}
findings.session_id = sessionId;
findings.q7_reported_model = { requested: agent.model ?? null, reported: field(created.event, "session", "agent", "model") ?? null };
await waitFor(isRootTerminal, "first root turn end");
findings.create_stream_end = await createDone;

// Step 2: long-lived session stream. Q5: sse ids and event_id ordering.
const streamAbort = new AbortController();
const streamRes = await fetch(`${BASE}/agents/sessions/${sessionId}/events?stream=true`, {
  headers: { ...headers, Accept: "text/event-stream" },
  signal: streamAbort.signal,
});
if (!streamRes.ok) {
  throw new Error(`stream open failed: ${streamRes.status}`);
}
const streamDone = readSse(streamRes, "session-stream");
await delay(500);

// Step 3: Q1, a message that lands mid-turn.
const turnsBefore = observed.filter((o) => o.event.type === "agent.session.turn.created").length;
findings.q1_first_post = await postEvents(sessionId, [message("Count slowly from 1 to 40, one number per line, no other text.")]);
await waitFor((o) => o.source === "session-stream" && o.event.type === "agent.session.turn.output_text.delta", "first delta");
const midTurn = observed.filter((o) => o.event.type === "agent.session.turn.created").length;
findings.q1_second_post = await postEvents(sessionId, [message("Stop counting immediately and reply with the single word STEERED.")]);
const steerPostedAt = counter;
const steerEnd = await waitFor((o) => o.source === "session-stream" && isRootTerminal(o) && o.n > steerPostedAt, "root turn end after steer");
await delay(1500);
const turnsAfter = observed.filter((o) => o.event.type === "agent.session.turn.created").length;
findings.q1_turns_created = { before: turnsBefore, afterFirstDelta: midTurn, afterSteerTurnEnd: turnsAfter };
findings.q1_verdict =
  turnsAfter - midTurn === 0 ? "steered: one turn absorbed both messages" : `new turn(s): ${turnsAfter - midTurn} extra turn.created after the mid-turn message`;
findings.q1_steer_turn_outcome = str(steerEnd.event.type);

// Step 4: Q2, cancel while idle.
await waitFor((o) => o.source === "session-stream" && o.event.type === "agent.session.idle" && o.n > steerEnd.n, "idle after steer", 30_000).catch(() => null);
findings.q2_cancel_on_idle = await postEvents(sessionId, [{ type: "agent.session.input.cancel" }]);

// Step 5: Q3/Q4, one subagent.
const subStart = observed.length;
findings.q3_post = await postEvents(sessionId, [
  message("Create exactly one subagent. Instruct it to reply with the single word PONG and nothing else. Wait for it, then reply with only the word it returned."),
]);
await waitFor((o) => o.source === "session-stream" && isRootTerminal(o) && o.n > subStart, "root turn end after subagent");
await delay(1500);
const subEvents = observed.slice(subStart);
const subCreated = subEvents.filter((o) => o.event.type === "agent.session.subagent.created");
const subTurnIds = new Set(
  subEvents
    .filter((o) => o.event.type === "agent.session.turn.created" && typeof field(o.event, "turn", "subagent_id") === "string")
    .map((o) => str(field(o.event, "turn", "id")))
    .filter((id): id is string => id !== null),
);
const firstItemPerTurn = new Map<string, number>();
const firstCreatedPerTurn = new Map<string, number>();
for (const o of subEvents) {
  const turnId = str(o.event.turn_id) ?? str(field(o.event, "turn", "id"));
  if (turnId !== null && subTurnIds.has(turnId)) {
    if (o.event.type === "agent.session.turn.created") {
      firstCreatedPerTurn.set(turnId, o.n);
    } else if (!firstItemPerTurn.has(turnId)) {
      firstItemPerTurn.set(turnId, o.n);
    }
  }
}
findings.q3 = {
  subagents_created: subCreated.map((o) => field(o.event, "subagent")),
  subagent_turns: [...subTurnIds],
  created_precedes_items: [...subTurnIds].map((id) => ({
    turn: id,
    created_n: firstCreatedPerTurn.get(id) ?? null,
    first_other_n: firstItemPerTurn.get(id) ?? null,
  })),
};
findings.q4 = {
  root_stream_event_types_during_subagent_turn: [...new Set(subEvents.map((o) => str(o.event.type)))],
  subagent_turn_text_deltas: subEvents.filter(
    (o) => o.event.type === "agent.session.turn.output_text.delta" && subTurnIds.has(str(o.event.turn_id) ?? ""),
  ).length,
  item_types_seen: [...new Set(subEvents.map((o) => str(field(o.event, "item", "type"))).filter((t) => t !== null))],
};

// Q5: ids.
const ids = observed.map((o) => str(o.event.event_id)).filter((id): id is string => id !== null);
findings.q5 = {
  sse_id_lines_present: observed.some((o) => o.sseId !== null),
  event_ids_sorted_lexically: ids.every((id, i) => i === 0 || (ids[i - 1] ?? "") <= id),
  sample_event_ids: ids.slice(0, 3),
};

// Q6: usage on terminal events vs retrieve.
const terminals = observed.filter((o) => ROOT_TERMINAL.has(str(o.event.type) ?? ""));
const usageChecks = await Promise.all(
  terminals.map(async (o) => {
    const turnId = str(field(o.event, "turn", "id")) ?? "";
    const retrieved = await getJson(`${BASE}/agents/sessions/${sessionId}/turns/${turnId}`);
    return { turn: turnId, subagent: field(o.event, "turn", "subagent_id") ?? null, event_usage: o.event.usage ?? null, retrieved_usage: retrieved.usage ?? null };
  }),
);
findings.q6 = usageChecks;

// Step 6: saved state for the record.
findings.items_page = await getJson(`${BASE}/agents/sessions/${sessionId}/items?order=asc&limit=100`);
findings.turns_page = await getJson(`${BASE}/agents/sessions/${sessionId}/turns?order=asc&limit=100`);

// Step 7: Q8, delete with the stream open.
if (keep) {
  findings.q8 = "skipped (--keep)";
  streamAbort.abort();
} else {
  const before = observed.length;
  const del = await fetch(`${BASE}/agents/sessions/${sessionId}`, { method: "DELETE", headers });
  findings.q8_delete_status = del.status;
  const ended = await Promise.race([streamDone, delay(15_000).then(() => "still-open" as const)]);
  if (ended === "still-open") {
    streamAbort.abort();
  }
  findings.q8 = { stream_after_delete: ended, events_after_delete: observed.slice(before).map((o) => str(o.event.type)) };
}
await streamDone.catch(() => null);

await writeFile(path.join(outDir, "events.jsonl"), `${observed.map((o) => JSON.stringify(o)).join("\n")}\n`);
await writeFile(path.join(outDir, "findings.json"), JSON.stringify(findings, null, 2));
process.stdout.write(`\n${JSON.stringify(findings, null, 2)}\nwrote ${outDir}\n`);
