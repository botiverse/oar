/**
 * SECOND CONTACT WITH THE OPENAI AGENTS API: sessions WITH an environment.
 *
 * `agents-api-probe.ts` used `environment: none` and could not see tools.
 * This script bills a sandbox to answer the questions an adapter for OAR's
 * coding-agent use cannot avoid:
 *
 *   S0 the completed-but-not-idle window: a message POSTed right after
 *      turn.completed and before agent.session.idle. Does it start a turn?
 *   S1 environment lifecycle: which environment events, in what order, how
 *      long until the first turn starts.
 *   S2 command items: `command_execution` item.added/done shapes and whether
 *      `agent.output.command_execution_output.delta` streams live.
 *   S3 steer at a tool boundary: a message POSTed while the FIRST of two
 *      commands runs. Same turn absorbs it (steer) or a new turn (queue)?
 *   S4 cancel a running command: latency to turn.cancelled, the command
 *      item's final status, whether the session goes idle.
 *   S5 reconnect: close the stream mid-turn, reopen; count the gap.
 *   S6 subagent with an environment: do its command items reach the root
 *      stream, and what turn_id do they carry?
 *   S7 artifacts: is a file under /workspace/outputs listed after the turn?
 *   F1 function tool: requires_action event, session/turn status while
 *      waiting, the accepted tool_result shape, recovery via retrieve.
 *   F2 reasoning: does `reasoning: { summary: "auto" }` produce
 *      reasoning_summary events?
 *   H1 self-hosted: register a LOCAL `codex exec-server` as the executor
 *      with the project key (docs want a separate environment key). If it
 *      connects, run one command in the local cwd. This is the hybrid shape
 *      an OAR adapter would take.
 *
 * ⚠️ NO SDK, NO REPO MACHINERY (plain fetch + SSE). Standalone by design;
 * helpers are duplicated from agents-api-probe.ts on purpose.
 *
 * Run: OPENAI_API_KEY=... NODE_USE_ENV_PROXY=1 pnpm tsx experiments/agents-api-sandbox-probe.ts [--model gpt-6-astra] [--skip S3,S6,H1] [--only-h1]
 *   H1 needs OPENAI_ENVIRONMENT_KEY: a restricted environment key with only the
 *   api.agents.environments.connect scope (platform dashboard, Agents tab). It is
 *   handed to the local executor as CODEX_API_KEY and nothing else.
 *   Writes oar-trial-run/agents-api-sandbox-<stamp>/{events.jsonl,findings.json}.
 *   Every session it creates is deleted at the end (best effort).
 *
 * ── OBSERVED 2026-09-12, gpt-6-astra, openai_hosted (network disabled) ─────
 *
 * S0 a message POSTed after turn.completed and before agent.session.idle
 *    started a turn normally (202). One earlier run lost a message in that
 *    same window (202, no turn ever, session idle afterwards); not
 *    reproduced, kept as an unexplained single occurrence.
 * S1 create → turn.created 9.9 s; environment.ready 30.9 s, .connected
 *    33.6 s, both AFTER the first command had already run and completed.
 *    Environment events are not a precondition the stream lets you wait on.
 * S2 command_execution item.added {command, cwd, status in_progress,
 *    output null} → agent.output.command_execution_output.delta per line →
 *    item.done {status completed, output, exit_code null, duration_ms null}.
 *    ⚠️ the FIRST output line was missing twice (tick-1, line-1) both in the
 *    deltas and in the saved item's output; a line printed 25 s in arrived.
 * S3 ⭐ STEER IS REAL AT A TOOL BOUNDARY: a message POSTed while
 *    `sleep 25; echo FIRST` ran was absorbed into the same turn, the second
 *    command never ran, the turn's final text was STEERED, and the steer
 *    message item sits in that turn. No new turn.created. Combined with
 *    agents-api-probe.ts: mid-turn input lands at the next step boundary
 *    (like claude), and a turn with no further step runs it as the next turn.
 * S4 cancel during `sleep 120`: 202; item.done {status: "incomplete"} then
 *    turn.cancelled 4.2 s after the POST, then idle. The turn retrieves as
 *    cancelled with error null. The incomplete command item was not found in
 *    the items list afterwards.
 * S5 ⚠️ reconnect: closing the stream mid-command and reopening 5 s later
 *    delivered a SNAPSHOT first (environment.ready, the turn's user message
 *    item.added completed, the running command item.added in_progress), then
 *    live events. The missed output deltas were not replayed AND no further
 *    output deltas arrived on the new stream at all (lines 5..12 never
 *    seen); item.done carried the full output. So a reopened stream is
 *    item-level, not delta-level.
 * S6 subagent with a sandbox: its command_execution item is NOT on the root
 *    stream; it is under /subagents/{sid}/items (with output) and its turn
 *    under /subagents/{sid}/turns (with usage). Root stream shows only
 *    subagent.created (twice) + create/agent_message/wait items.
 * S7 GET /sessions/{id}/artifacts lists /workspace/outputs/hello.txt with
 *    turn_id, path, size_bytes after the turn completed.
 * F1 function tool: agent.session.requires_action carries session.status
 *    requires_action; retrieve gives required_actions [{function_call,
 *    turn_id, call_id, name, arguments}]; the turn retrieves as `waiting`;
 *    {type: agent.session.input.tool_result, turn_id, call_id, success:
 *    true, output: "<string>"} is accepted (202) and the turn completes
 *    with items function_call + function_call_output.
 * F2 reasoning {effort medium, summary auto}: zero reasoning events, zero
 *    reasoning items on gpt-6-astra for a trivial task.
 * H1 self-hosted (--only-h1, codex 0.154.0): environment.remote_url is
 *    https://api.openai.com/v1/agents/api/connect/rt_<id>. A local
 *    `codex exec-server --remote <url> --environment-id <id>` with the
 *    PROJECT key as CODEX_API_KEY is refused ("403 Forbidden: missing
 *    required scope api.agents.environments.connect"). With a restricted
 *    ENVIRONMENT key it registered, `agent.session.environment.connected`
 *    was the first event on the stream, and the turn ran
 *    `/bin/zsh -lc 'pwd && ls | head -5 && echo LOCAL-OK'` in THIS repo's
 *    cwd with complete output (first line present this time). The executor
 *    printed nothing on stdout/stderr while connected. The hybrid shape
 *    (remote session, local executor in `cwd`) works end to end.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const BASE = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const KEY = process.env.OPENAI_API_KEY;
if (KEY === undefined || KEY === "") {
  throw new Error("OPENAI_API_KEY is required (an api.agents.* project key)");
}
const args = process.argv.slice(2);
const MODEL = args.includes("--model") ? (args[args.indexOf("--model") + 1] ?? "gpt-6-astra") : "gpt-6-astra";
const skipped = new Set((args.includes("--skip") ? (args[args.indexOf("--skip") + 1] ?? "") : "").split(",").filter((s) => s !== ""));
const ENV_KEY = process.env.OPENAI_ENVIRONMENT_KEY;
const onlyH1 = args.includes("--only-h1");
const TURN_TIMEOUT_MS = 300_000;

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
  readonly stream: string;
  readonly event: Json;
}
const observed: Observed[] = [];
const findings: Json = {};
const waiters = new Set<(o: Observed) => void>();
const sessionsToDelete: string[] = [];
let counter = 0;

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
function typeOf(o: Observed): string {
  return str(o.event.type) ?? "?";
}
function itemType(o: Observed): string | null {
  return str(field(o.event, "item", "type"));
}
function turnOf(o: Observed): string | null {
  return str(o.event.turn_id) ?? str(field(o.event, "turn", "id"));
}
function note(o: Observed): void {
  observed.push(o);
  const delta = str(o.event.delta);
  const item = itemType(o);
  const turn = turnOf(o);
  const tag = `${item === null ? "" : ` item=${item}`}${turn === null ? "" : ` turn=…${turn.slice(-6)}`}${delta === null ? "" : ` ${JSON.stringify(delta.slice(0, 40))}`}`;
  process.stdout.write(`${o.n} [${o.stream}] ${typeOf(o)}${tag}\n`);
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
const isRootTerminal = (o: Observed): boolean => ROOT_TERMINAL.has(typeOf(o)) && field(o.event, "turn", "subagent_id") === null;
const after =
  (n: number) =>
  (o: Observed): boolean =>
    o.n > n;

// ─── SSE + HTTP ────────────────────────────────────────────────────────────

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return { type: "<unparseable>", raw: data };
  }
}
async function readSse(res: Response, stream: string): Promise<"eof" | "abort"> {
  if (res.body === null) {
    throw new Error(`${stream}: no body`);
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (frame: string): void => {
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      }
    }
    if (data === "" || data === "[DONE]") {
      return;
    }
    const parsed: unknown = parseJson(data);
    counter += 1;
    note({ n: counter, at: Date.now(), stream, event: isRecord(parsed) ? parsed : { type: "<non-object>", raw: parsed } });
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
    return "eof";
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return "abort";
    }
    throw error;
  }
}
interface OpenStream {
  readonly done: Promise<"eof" | "abort">;
  readonly abort: () => void;
}
async function openStream(sessionId: string, label: string): Promise<OpenStream> {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/agents/sessions/${sessionId}/events?stream=true`, {
    headers: { ...headers, Accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!res.ok) {
    throw new Error(`stream open failed: ${res.status}`);
  }
  return {
    done: readSse(res, label),
    abort: () => {
      controller.abort();
    },
  };
}
async function http(method: string, url: string, body?: Json): Promise<{ status: number; json: Json | null; text: string }> {
  const init: RequestInit = body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) };
  const res = await fetch(url, init);
  const text = await res.text();
  const parsed: unknown = text === "" ? null : parseJson(text);
  return { status: res.status, json: isRecord(parsed) ? parsed : null, text: text.slice(0, 800) };
}
const message = (text: string): Json => ({
  type: "agent.session.input.message",
  input: [{ role: "user", content: [{ type: "input_text", text }] }],
});
const posts: Json[] = [];
async function send(sessionId: string, events: Json[]): Promise<{ status: number; text: string }> {
  const r = await http("POST", `${BASE}/agents/sessions/${sessionId}/events`, { events });
  posts.push({ at: Date.now(), session: sessionId.slice(-6), types: events.map((e) => e.type), status: r.status, text: r.text });
  return { status: r.status, text: r.text };
}
/** The documented precondition for a new turn: the session is idle. */
async function idleAfter(o: Observed, stream: string): Promise<void> {
  await waitFor((x) => x.n > o.n && x.stream === stream && typeOf(x) === "agent.session.idle", `idle after ${typeOf(o)}`, 60_000);
}
async function createSession(body: Json): Promise<string> {
  const r = await http("POST", `${BASE}/agents/sessions`, body);
  const id = str(r.json?.id);
  if (id === null) {
    throw new Error(`create failed: ${r.status} ${r.text}`);
  }
  sessionsToDelete.push(id);
  return id;
}
async function listAll(url: string): Promise<Json[]> {
  const r = await http("GET", url);
  const data = r.json?.data;
  return Array.isArray(data) ? data.filter((d) => isRecord(d)) : [];
}
function summarizeItems(items: Json[]): Json[] {
  return items.map((i) => ({
    type: i.type,
    status: i.status ?? null,
    turn: str(i.turn_id)?.slice(-6) ?? null,
    command: i.command ?? undefined,
    output: typeof i.output === "string" ? i.output.slice(0, 120) : undefined,
    exit_code: i.exit_code ?? undefined,
    text: str(field(i, "content", "0", "text"))?.slice(0, 80) ?? undefined,
  }));
}
const elapsed = (from: number): number => Math.round((Date.now() - from) / 100) / 10;
const skip = (id: string): boolean => {
  if (skipped.has(id)) {
    findings[id] = "skipped";
    return true;
  }
  return false;
};

// ─── setup ─────────────────────────────────────────────────────────────────

const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
const outDir = path.join(process.cwd(), "oar-trial-run", `agents-api-sandbox-${stamp}`);
await mkdir(outDir, { recursive: true });
const INSTRUCTIONS = "You are a probe target. Follow instructions literally. Run exactly the shell commands you are told, one at a time, and nothing else.";

// ─── S1/S2: hosted sandbox, one command, watch the environment come up ─────

if (onlyH1) {
  await selfHosted();
  await teardown(null);
}

const t0 = Date.now();
const hosted = await createSession({
  agent: { model: MODEL, instructions: INSTRUCTIONS, multi_agent: { enabled: true, max_concurrent_subagents: 1 } },
  environment: { type: "openai_hosted", network: { access: "disabled" } },
});
findings.hosted_session = hosted;
let hostedStream = await openStream(hosted, "hosted");
let hostedLabel = "hosted";
try {
const s1Post = await send(hosted, [message("Run this shell command: for i in 1 2 3; do echo tick-$i; sleep 1; done; echo TICKED. Then reply DONE.")]);
const s1End = await waitFor(isRootTerminal, "S1 turn end");
findings.S1 = {
  create_to_first_input_status: s1Post.status,
  environment_events_in_order: observed.filter((o) => typeOf(o).startsWith("agent.session.environment.")).map((o) => ({ type: typeOf(o), at_s: elapsed(t0) - elapsed(o.at), status: field(o.event, "environment", "status") ?? null })),
  turn_created_after_s: ((): number | null => {
    const c = observed.find((o) => typeOf(o) === "agent.session.turn.created");
    return c === undefined ? null : Math.round((c.at - t0) / 100) / 10;
  })(),
  turn_outcome: typeOf(s1End),
};
const s1Cmd = observed.filter((o) => itemType(o) === "command_execution" || typeOf(o) === "agent.output.command_execution_output.delta");
findings.S2 = {
  command_event_sequence: s1Cmd.map((o) => ({ n: o.n, type: typeOf(o), status: field(o.event, "item", "status") ?? null, delta: str(o.event.delta) ?? undefined })),
  item_added_shape: s1Cmd.find((o) => typeOf(o) === "agent.session.turn.item.added")?.event.item ?? null,
  item_done_shape: s1Cmd.find((o) => typeOf(o) === "agent.session.turn.item.done")?.event.item ?? null,
  output_deltas: s1Cmd.filter((o) => typeOf(o) === "agent.output.command_execution_output.delta").length,
  all_item_types_seen: [...new Set(observed.map((o) => itemType(o)).filter((t) => t !== null))],
};

// ─── S0: message in the completed-but-not-idle window ─────────────────────

{
  // s1End is turn.completed; idle normally follows within ~0.5 s. Post NOW.
  const idleAlready = observed.some((o) => o.n > s1End.n && typeOf(o) === "agent.session.idle");
  const before = counter;
  const post = await send(hosted, [message("Run this shell command: echo RACE. Then reply RACED.")]);
  const created = await waitFor((o) => o.n > before && typeOf(o) === "agent.session.turn.created", "S0 turn after race post", 30_000).catch(() => null);
  if (created !== null) {
    const end = await waitFor((o) => o.n > created.n && isRootTerminal(o), "S0 turn end");
    await idleAfter(end, hostedLabel);
  }
  findings.S0 = {
    idle_had_already_arrived_when_posting: idleAlready,
    post_status: post.status,
    turn_started: created !== null,
    verdict: created === null ? "LOST: 202 but no turn ever started (message dropped in the completed-but-not-idle window)" : "started a turn",
  };
  if (created === null) {
    // recover the session for the remaining scenarios
    await send(hosted, [message("Reply with the single word RECOVERED.")]);
    const end = await waitFor((o) => o.n > before && isRootTerminal(o), "S0 recovery turn end");
    await idleAfter(end, hostedLabel);
  }
}

// ─── S3: steer at a tool boundary ──────────────────────────────────────────

if (!skip("S3")) {
  const before = counter;
  await send(hosted, [message("Run exactly these two shell commands, one at a time, as two separate commands: first `sleep 25; echo FIRST`, then `echo SECOND`. After both finish, reply DONE.")]);
  const firstCmd = await waitFor((o) => o.n > before && typeOf(o) === "agent.session.turn.item.added" && itemType(o) === "command_execution", "S3 first command start");
  await delay(3000);
  const steerPost = await send(hosted, [message("Change of plan: do NOT run the second command. Reply with only the word STEERED.")]);
  const steerAt = counter;
  const turnA = turnOf(firstCmd);
  const endA = await waitFor((o) => isRootTerminal(o) && turnOf(o) === turnA, "S3 turn A end");
  await delay(4000);
  const newTurns = observed.filter((o) => o.n > steerAt && typeOf(o) === "agent.session.turn.created");
  let endB: Observed | null = null;
  if (newTurns.length > 0) {
    endB = await waitFor((o) => isRootTerminal(o) && turnOf(o) === turnOf(newTurns[0] ?? firstCmd), "S3 turn B end");
  }
  await idleAfter(endB ?? endA, hostedLabel);
  const items = await listAll(`${BASE}/agents/sessions/${hosted}/items?order=asc&limit=100`);
  const turnAItems = items.filter((i) => i.turn_id === turnA);
  const commandsInA = turnAItems.filter((i) => i.type === "command_execution").map((i) => str(i.command));
  findings.S3 = {
    steer_post_status: steerPost.status,
    turn_A_outcome: typeOf(endA),
    new_turns_after_steer: newTurns.length,
    turn_B_outcome: endB === null ? null : typeOf(endB),
    commands_run_in_turn_A: commandsInA,
    second_command_ran: commandsInA.some((c) => c?.includes("SECOND") === true),
    turn_A_final_texts: turnAItems.filter((i) => i.type === "message" && i.role === "assistant").map((i) => str(field(i, "content", "0", "text"))),
    steer_message_item_turn: items.find((i) => str(field(i, "content", "0", "text"))?.startsWith("Change of plan") === true)?.turn_id === turnA ? "in turn A" : "in a later turn",
    verdict: newTurns.length === 0 ? "STEERED: absorbed into the running turn" : "QUEUED: ran as a new turn after A finished",
  };
}

// ─── S4: cancel a running command ──────────────────────────────────────────

{
  const before = counter;
  await send(hosted, [message("Run this shell command: sleep 120; echo LONG. Then reply LONGDONE.")]);
  const cmd = await waitFor((o) => o.n > before && typeOf(o) === "agent.session.turn.item.added" && itemType(o) === "command_execution", "S4 command start");
  await delay(3000);
  const cancelAt = Date.now();
  const cancelPost = await send(hosted, [{ type: "agent.session.input.cancel" }]);
  const end = await waitFor((o) => isRootTerminal(o) && turnOf(o) === turnOf(cmd), "S4 turn end", 120_000);
  const idle = await waitFor((o) => o.n > end.n && typeOf(o) === "agent.session.idle", "S4 idle", 30_000).catch(() => null);
  const items = await listAll(`${BASE}/agents/sessions/${hosted}/items?order=asc&limit=100`);
  const cmdItem = items.find((i) => i.id === field(cmd.event, "item", "id"));
  const turn = await http("GET", `${BASE}/agents/sessions/${hosted}/turns/${turnOf(cmd) ?? ""}`);
  findings.S4 = {
    cancel_post_status: cancelPost.status,
    turn_outcome: typeOf(end),
    cancel_to_terminal_s: Math.round((end.at - cancelAt) / 100) / 10,
    idle_followed: idle !== null,
    command_item_final: cmdItem === undefined ? null : { status: cmdItem.status, exit_code: cmdItem.exit_code ?? null, output: str(cmdItem.output)?.slice(0, 100) ?? null },
    turn_retrieve: { status: turn.json?.status ?? null, error: turn.json?.error ?? null },
    events_between_cancel_and_terminal: observed.filter((o) => o.at >= cancelAt && o.n < end.n).map((o) => typeOf(o)),
  };
}

// ─── S5: disconnect mid-turn, reopen, measure the gap ─────────────────────

{
  const before = counter;
  await send(hosted, [message("Run this shell command: for i in $(seq 1 12); do echo line-$i; sleep 1; done. Then reply COUNTED.")]);
  await waitFor((o) => o.n > before && typeOf(o) === "agent.session.turn.item.added" && itemType(o) === "command_execution", "S5 command start");
  const lastBeforeClose = counter;
  hostedStream.abort();
  const closedAs = await hostedStream.done;
  await delay(5000);
  const reopened = await openStream(hosted, "hosted-2");
  const firstAfter = await waitFor(after(lastBeforeClose), "S5 first event after reopen", 60_000);
  const end = await waitFor((o) => o.n > lastBeforeClose && isRootTerminal(o), "S5 turn end");
  findings.S5 = {
    stream_closed_as: closedAs,
    gap_s: 5,
    first_event_after_reopen: typeOf(firstAfter),
    events_after_reopen_before_end: observed.filter((o) => o.n > lastBeforeClose && o.n <= end.n).map((o) => typeOf(o)),
    note: "compare line-N deltas seen before close vs after reopen to see which were lost",
    output_deltas_seen_after_reopen: observed.filter((o) => o.n > lastBeforeClose && typeOf(o) === "agent.output.command_execution_output.delta").map((o) => str(o.event.delta)),
  };
  await idleAfter(end, "hosted-2");
  hostedStream = reopened;
  hostedLabel = "hosted-2";
}

// ─── S6: subagent that runs a command ─────────────────────────────────────

if (!skip("S6")) {
  const before = counter;
  await send(hosted, [message("Create exactly one subagent. Instruct it to run the shell command `echo PONG-FROM-SUB` and reply with the command's output only. Wait for it, then reply with only what it returned.")]);
  const end = await waitFor((o) => o.n > before && isRootTerminal(o), "S6 root turn end");
  await idleAfter(end, hostedLabel);
  await delay(3000);
  const evs = observed.filter((o) => o.n > before && o.n <= end.n + 5);
  const subId = str(field(evs.find((o) => typeOf(o) === "agent.session.subagent.created")?.event, "subagent", "id"));
  const rootTurn = turnOf(end);
  const subTurns = subId === null ? [] : await listAll(`${BASE}/agents/sessions/${hosted}/subagents/${subId}/turns?order=asc&limit=50`);
  const subItems = subId === null ? [] : await listAll(`${BASE}/agents/sessions/${hosted}/subagents/${subId}/items?order=asc&limit=50`);
  const rootItems = await listAll(`${BASE}/agents/sessions/${hosted}/items?order=asc&limit=100`);
  findings.S6 = {
    subagent_id: subId,
    root_stream_event_types: [...new Set(evs.map((o) => typeOf(o)))],
    root_stream_item_types: [...new Set(evs.map((o) => itemType(o)).filter((t) => t !== null))],
    command_items_on_root_stream: evs.filter((o) => itemType(o) === "command_execution").map((o) => ({ turn: turnOf(o)?.slice(-6), is_root_turn: turnOf(o) === rootTurn, command: field(o.event, "item", "command") })),
    subagent_turn_events_on_root_stream: evs.filter((o) => typeof field(o.event, "turn", "subagent_id") === "string").length,
    subagent_turns_endpoint: subTurns.map((t) => ({ id: str(t.id)?.slice(-6), status: t.status, subagent_id: t.subagent_id, usage: t.usage ?? null })),
    subagent_items_endpoint: summarizeItems(subItems),
    root_items_for_this_turn: summarizeItems(rootItems.filter((i) => i.turn_id === rootTurn)),
  };
}

// ─── S7: artifacts ─────────────────────────────────────────────────────────

{
  const before = counter;
  await send(hosted, [message("Run this shell command: mkdir -p /workspace/outputs && echo hello-artifact > /workspace/outputs/hello.txt. Then reply SAVED.")]);
  const end = await waitFor((o) => o.n > before && isRootTerminal(o), "S7 turn end");
  await idleAfter(end, hostedLabel);
  await delay(3000);
  const list = await http("GET", `${BASE}/agents/sessions/${hosted}/artifacts?limit=20`);
  findings.S7 = { turn: turnOf(end)?.slice(-6), artifacts_status: list.status, artifacts: list.json?.data ?? list.text };
}

// ─── F1/F2: function tool + reasoning summaries (no environment) ──────────

{
  const fn = await createSession({
    agent: {
      model: MODEL,
      instructions: "When asked for the secret, call the get_secret function and then reply with exactly what it returned.",
      reasoning: { effort: "medium", summary: "auto" },
      tools: [{ type: "function", name: "get_secret", description: "Returns the secret word.", parameters: { type: "object", properties: {}, additionalProperties: false } }],
    },
    environment: { type: "none" },
    input: "What is the secret?",
  });
  findings.fn_session = fn;
  const fnStream = await openStream(fn, "fn");
  const req = await waitFor((o) => o.stream === "fn" && typeOf(o) === "agent.session.requires_action", "F1 requires_action", 120_000);
  const session = await http("GET", `${BASE}/agents/sessions/${fn}`);
  const actions = session.json?.required_actions;
  const action = Array.isArray(actions) ? actions.find((a) => isRecord(a)) : undefined;
  const turnId = str(action?.turn_id);
  const callId = str(action?.call_id);
  const turn = turnId === null ? null : await http("GET", `${BASE}/agents/sessions/${fn}/turns/${turnId}`);
  const attempts: Json[] = [];
  const shapes: Json[] = [
    { type: "agent.session.input.tool_result", turn_id: turnId, call_id: callId, success: true, output: "swordfish" },
    { type: "agent.session.input.tool_result", turn_id: turnId, call_id: callId, success: true, output: [{ type: "input_text", text: "swordfish" }] },
  ];
  let accepted: Json | null = null;
  for (const shape of shapes) {
    // eslint-disable-next-line no-await-in-loop
    const r = await send(fn, [shape]);
    attempts.push({ shape, status: r.status, text: r.text });
    if (r.status < 300) {
      accepted = shape;
      break;
    }
  }
  const end = accepted === null ? null : await waitFor((o) => o.stream === "fn" && isRootTerminal(o), "F1 turn end", 120_000);
  const items = await listAll(`${BASE}/agents/sessions/${fn}/items?order=asc&limit=50`);
  findings.F1 = {
    requires_action_event_session_status: field(req.event, "session", "status") ?? null,
    required_actions_from_retrieve: actions ?? null,
    turn_status_while_waiting: turn?.json?.status ?? null,
    tool_result_attempts: attempts,
    turn_outcome: end === null ? null : typeOf(end),
    final_texts: items.filter((i) => i.type === "message" && i.role === "assistant").map((i) => str(field(i, "content", "0", "text"))),
    item_types: [...new Set(items.map((i) => i.type))],
  };
  findings.F2 = {
    reasoning_event_types: [...new Set(observed.filter((o) => o.stream === "fn" && typeOf(o).includes("reasoning")).map((o) => typeOf(o)))],
    reasoning_items: items.filter((i) => i.type === "reasoning").length,
  };
  fnStream.abort();
  await fnStream.done;
}

// ─── H1: self-hosted executor = local `codex exec-server` ─────────────────

if (!skip("H1")) {
  await selfHosted();
}

} catch (error) {
  findings.crash = error instanceof Error ? error.stack ?? error.message : String(error);
}


// ─── H1 body (a function so the nesting stays lintable) ───────────────────

async function selfHosted(): Promise<void> {
  let child: ChildProcess | null = null;
  const log: string[] = [];
  try {
    const sh = await createSession({
      agent: { model: MODEL, instructions: INSTRUCTIONS },
      environment: { type: "self_hosted", workspace_directory: process.cwd() },
    });
    findings.self_hosted_session = sh;
    const s = await http("GET", `${BASE}/agents/sessions/${sh}`);
    const envId = str(field(s.json, "environment", "id"));
    const remoteUrl = str(field(s.json, "environment", "remote_url"));
    findings.H1_environment = { id: envId, remote_url: remoteUrl, status: field(s.json, "environment", "status") ?? null };
    const shStream = await openStream(sh, "self");
    if (envId !== null && remoteUrl !== null) {
      child = spawn("codex", ["exec-server", "--remote", remoteUrl, "--environment-id", envId, "--name", "oar-probe"], {
        cwd: process.cwd(),
        env: { ...process.env, CODEX_API_KEY: ENV_KEY ?? KEY },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (d: Buffer) => {
        log.push(`out: ${d.toString()}`);
      });
      child.stderr?.on("data", (d: Buffer) => {
        log.push(`err: ${d.toString()}`);
      });
      child.on("exit", (code) => {
        log.push(`exit: ${code}`);
      });
      const connected = await waitFor((o) => o.stream === "self" && ["agent.session.environment.connected", "agent.session.environment.ready", "agent.session.environment.failed"].includes(typeOf(o)), "H1 environment connect", 90_000).catch((error: unknown) => (error instanceof Error ? error.message : "?"));
      findings.H1_connect = typeof connected === "string" ? { timeout: connected } : { event: typeOf(connected), environment: connected.event.environment ?? null };
      if (typeof connected !== "string" && typeOf(connected) !== "agent.session.environment.failed") {
        const before = counter;
        await send(sh, [message("Run this shell command: pwd && ls | head -5 && echo LOCAL-OK. Then reply DONE.")]);
        const end = await waitFor((o) => o.n > before && o.stream === "self" && isRootTerminal(o), "H1 turn end", 180_000);
        const items = await listAll(`${BASE}/agents/sessions/${sh}/items?order=asc&limit=50`);
        findings.H1_turn = { outcome: typeOf(end), items: summarizeItems(items) };
      }
    }
    shStream.abort();
    await shStream.done;
  } catch (error) {
    findings.H1_error = error instanceof Error ? error.message : String(error);
  } finally {
    child?.kill();
    findings.H1_executor_log = log.join("").slice(0, 3000);
  }
}

// ─── teardown ──────────────────────────────────────────────────────────────

async function teardown(stream: OpenStream | null): Promise<never> {
  findings.posts = posts;
  stream?.abort();
  const deletions = await Promise.all(
    sessionsToDelete.map(async (id) => {
      const r = await http("DELETE", `${BASE}/agents/sessions/${id}`);
      return { id, status: r.status };
    }),
  );
  findings.deletions = deletions;
  await writeFile(path.join(outDir, "events.jsonl"), `${observed.map((o) => JSON.stringify(o)).join("\n")}\n`);
  await writeFile(path.join(outDir, "findings.json"), JSON.stringify(findings, null, 2));
  process.stdout.write(`\n${JSON.stringify(findings, null, 2)}\nwrote ${outDir}\n`);
  process.exit(0);
}
await teardown(hostedStream);
