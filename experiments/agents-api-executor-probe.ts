/**
 * THIRD CONTACT WITH THE OPENAI AGENTS API: the self-hosted executor's
 * lifecycle, which is what an OAR adapter would own as its local process.
 *
 * All sessions are `self_hosted` with a local `codex exec-server` in this
 * cwd, so nothing here bills a sandbox; only tokens.
 *
 *   E1 input before any executor: does the API park the turn behind an
 *      `environment_connection` required action, and does starting the
 *      executor afterwards let the original input proceed unresubmitted?
 *   E2 executor killed mid-command: what the stream says
 *      (environment.disconnected? turn.failed? waiting?), and what the
 *      command item and turn look like afterwards.
 *   E3 replacement executor on the SAME environment id: does it connect,
 *      and does the next message run?
 *   E4 session deleted while the executor is connected: does the executor
 *      process exit on its own (docs: deletion does not stop compute)?
 *   R1 the completed-but-not-idle window, five attempts: post a message
 *      the instant the root turn.completed arrives; count turns started.
 *
 * ⚠️ NO SDK, NO REPO MACHINERY (plain fetch + SSE). Standalone by design.
 *
 * Run: OPENAI_API_KEY=... OPENAI_ENVIRONMENT_KEY=... NODE_USE_ENV_PROXY=1 pnpm tsx experiments/agents-api-executor-probe.ts [--model gpt-6-astra]
 *   Writes oar-trial-run/agents-api-executor-<stamp>/{events.jsonl,findings.json}.
 *
 * ── OBSERVED 2026-09-12, gpt-6-astra, codex 0.154.0 exec-server, macOS ──────
 *
 * E1 input with no executor: agent.session.requires_action after 1.8 s with
 *    session.required_actions [{environment_connection, environment_id}].
 *    ⚠️ the POST /events itself stays OPEN until the executor connects (it
 *    returned 202 after 10.4 s, once connected); a first attempt that
 *    awaited it behind the shell proxy died with "fetch failed" and that
 *    session's input was gone for good. Executor connected 5.5 s after
 *    start; the original input then ran WITHOUT resubmission. Stream order:
 *    requires_action, environment.connected, idle, THEN turn.created.
 * E2 SIGKILL the executor 5 s into `sleep 40`: environment.disconnected
 *    20.6 s later; the command item.done arrives `failed` with output
 *    "exec-server transport disconnected; failed to resume exec-server
 *    session: recovery timed out after 25s"; the harness then reasoned
 *    (reasoning item + reasoning_summary_* events DID appear here) and
 *    replied that the command had not confirmed completion; turn.completed
 *    51.6 s after the kill, turn.error null. Executor death is a failed tool
 *    inside a completed turn, exactly as the docs warn.
 * E3 a replacement `codex exec-server` on the SAME environment id connected
 *    (environment.connected ~80 s after its start, past this script's 90 s
 *    wait window measured from a slightly earlier point) and every later
 *    command (ten of them) ran through it. Reconnect is slow but works.
 * R1 five messages posted the instant turn.completed arrived, before idle:
 *    5/5 started turns and completed. The single lost message in
 *    agents-api-sandbox-probe.ts run 1 stays unexplained.
 * E4 DELETE with the executor connected: 200; the session stream ended
 *    with a bare EOF; the executor process was still alive 15 s later
 *    (docs: deletion does not stop compute). The adapter must kill it.
 * ⚠️ A self-hosted session whose first turn never ran (the E1 casualty
 *    above) cannot be deleted: DELETE is 409 `conflict_error` "session has
 *    no durably bound CCA root", also after a cancel, also after an
 *    executor was connected to it and it went idle. It lingers.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const BASE = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const KEY = process.env.OPENAI_API_KEY;
const ENV_KEY = process.env.OPENAI_ENVIRONMENT_KEY;
if (KEY === undefined || KEY === "" || ENV_KEY === undefined || ENV_KEY === "") {
  throw new Error("OPENAI_API_KEY (project key) and OPENAI_ENVIRONMENT_KEY (environment key) are required");
}
const args = process.argv.slice(2);
const MODEL = args.includes("--model") ? (args[args.indexOf("--model") + 1] ?? "gpt-6-astra") : "gpt-6-astra";
const headers = { Authorization: `Bearer ${KEY}`, "OpenAI-Beta": "agents=v1", "Content-Type": "application/json" };

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
const typeOf = (o: Observed): string => str(o.event.type) ?? "?";
const itemType = (o: Observed): string | null => str(field(o.event, "item", "type"));
const turnOf = (o: Observed): string | null => str(o.event.turn_id) ?? str(field(o.event, "turn", "id"));
function note(o: Observed): void {
  observed.push(o);
  const item = itemType(o);
  const env = str(field(o.event, "environment", "status"));
  process.stdout.write(`${o.n} [${o.stream}] ${typeOf(o)}${item === null ? "" : ` item=${item}`}${env === null ? "" : ` env=${env}`}\n`);
  for (const w of waiters) {
    w(o);
  }
}
async function waitFor(pred: (o: Observed) => boolean, what: string, ms = 180_000): Promise<Observed> {
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
  const res = await fetch(`${BASE}/agents/sessions/${sessionId}/events?stream=true`, { headers: { ...headers, Accept: "text/event-stream" }, signal: controller.signal });
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
const message = (text: string): Json => ({ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text }] }] });
const posts: Json[] = [];
async function send(sessionId: string, events: Json[]): Promise<{ status: number; text: string }> {
  const r = await http("POST", `${BASE}/agents/sessions/${sessionId}/events`, { events });
  posts.push({ at: Date.now(), session: sessionId.slice(-6), types: events.map((e) => e.type), status: r.status, text: r.text });
  return { status: r.status, text: r.text };
}
async function retrieve(sessionId: string): Promise<Json> {
  const r = await http("GET", `${BASE}/agents/sessions/${sessionId}`);
  return r.json ?? {};
}
async function items(sessionId: string): Promise<Json[]> {
  const r = await http("GET", `${BASE}/agents/sessions/${sessionId}/items?order=asc&limit=100`);
  const data = r.json?.data;
  return Array.isArray(data) ? data.filter((d) => isRecord(d)) : [];
}
const brief = (list: Json[]): Json[] => list.map((i) => ({ type: i.type, status: i.status ?? null, turn: str(i.turn_id)?.slice(-6) ?? null, command: i.command ?? undefined, output: typeof i.output === "string" ? i.output.slice(0, 80) : undefined, text: str(field(i, "content", "0", "text"))?.slice(0, 60) ?? undefined }));

interface Executor {
  readonly child: ChildProcess;
  readonly log: string[];
  readonly exited: Promise<number | null>;
}
function startExecutor(remoteUrl: string, envId: string, name: string): Executor {
  const log: string[] = [];
  const child = spawn("codex", ["exec-server", "--remote", remoteUrl, "--environment-id", envId, "--name", name], {
    cwd: process.cwd(),
    env: { ...process.env, CODEX_API_KEY: ENV_KEY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d: Buffer) => {
    log.push(`out: ${d.toString()}`);
  });
  child.stderr.on("data", (d: Buffer) => {
    log.push(`err: ${d.toString()}`);
  });
  const { promise, resolve } = Promise.withResolvers<number | null>();
  child.on("exit", (code) => {
    log.push(`exit: ${code}`);
    resolve(code);
  });
  return { child, log, exited: promise };
}
async function createSelfHosted(): Promise<{ id: string; envId: string; remoteUrl: string }> {
  const r = await http("POST", `${BASE}/agents/sessions`, {
    agent: { model: MODEL, instructions: "You are a probe target. Run exactly the shell commands you are told, one at a time, and nothing else." },
    environment: { type: "self_hosted", workspace_directory: process.cwd() },
  });
  const id = str(r.json?.id);
  const envId = str(field(r.json, "environment", "id"));
  const remoteUrl = str(field(r.json, "environment", "remote_url"));
  if (id === null || envId === null || remoteUrl === null) {
    throw new Error(`create failed: ${r.status} ${r.text}`);
  }
  sessionsToDelete.push(id);
  return { id, envId, remoteUrl };
}
const secs = (from: number, to: number): number => Math.round((to - from) / 100) / 10;

/** A send whose HTTP failure is data, plus how long the request stayed open. */
async function timedSend(sessionId: string, text: string, startedAt: number): Promise<Json> {
  try {
    const r = await send(sessionId, [message(text)]);
    return { ...r, returned_after_s: secs(startedAt, Date.now()) };
  } catch (error) {
    const code = str(field(error instanceof Error ? error.cause : null, "code"));
    return { status: -1, text: `${error instanceof Error ? error.message : String(error)}${code === null ? "" : ` (${code})`}`, returned_after_s: secs(startedAt, Date.now()) };
  }
}

/** One R1 attempt: run a turn, then post the next message the instant the root turn.completed arrives. */
async function raceAttempt(sessionId: string, i: number): Promise<Json> {
  const before = counter;
  await send(sessionId, [message(`Run this shell command: echo R1-${i}. Then reply DONE.`)]);
  const end = await waitFor((o) => o.stream === "A" && o.n > before && isRootTerminal(o), `R1 turn ${i} end`, 120_000);
  const idleSeen = observed.some((o) => o.n > end.n && typeOf(o) === "agent.session.idle");
  const b2 = counter;
  const p = await send(sessionId, [message(`Run this shell command: echo R1-${i}-race. Then reply DONE.`)]);
  const created = await waitFor((o) => o.stream === "A" && o.n > b2 && typeOf(o) === "agent.session.turn.created", `R1 race ${i}`, 30_000).catch(() => null);
  let raceEnd: Observed | null = null;
  if (created !== null) {
    raceEnd = await waitFor((o) => o.stream === "A" && o.n > created.n && isRootTerminal(o), `R1 race ${i} end`, 120_000);
  }
  const lastN = (raceEnd ?? end).n;
  await waitFor((o) => o.stream === "A" && o.n > lastN && typeOf(o) === "agent.session.idle", "R1 idle", 30_000).catch(() => null);
  return { i, idle_already_seen: idleSeen, post_status: p.status, race_turn_started: created !== null, race_turn_outcome: raceEnd === null ? null : typeOf(raceEnd) };
}

const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
const outDir = path.join(process.cwd(), "oar-trial-run", `agents-api-executor-${stamp}`);
await mkdir(outDir, { recursive: true });
const executors: Executor[] = [];

try {
  // ─── E1: input before any executor ─────────────────────────────────────
  const a = await createSelfHosted();
  findings.session_a = a.id;
  const streamA = await openStream(a.id, "A");
  const postAt = Date.now();
  // The docs say this request can stay open until the executor connects (up to
  // five minutes), so it is NOT awaited before the executor is started.
  // oxlint-disable-next-line unicorn/prefer-top-level-await -- the request must stay open while the executor is started.
  const postPromise = timedSend(a.id, "Run this shell command: echo E1-OK. Then reply DONE.", postAt);
  const ra = await waitFor((o) => o.stream === "A" && typeOf(o) === "agent.session.requires_action", "E1 requires_action", 60_000).catch(() => null);
  const parked = await retrieve(a.id);
  const exec1 = startExecutor(a.remoteUrl, a.envId, "oar-probe-1");
  executors.push(exec1);
  const connected = await waitFor((o) => o.stream === "A" && typeOf(o) === "agent.session.environment.connected", "E1 connected", 90_000);
  const end = await waitFor((o) => o.stream === "A" && o.n > connected.n && isRootTerminal(o), "E1 turn end");
  const post = await postPromise;
  const e1Items = await items(a.id);
  findings.E1 = {
    post,
    requires_action_event_after_s: ra === null ? null : secs(postAt, ra.at),
    parked_session: { status: parked.status ?? null, required_actions: parked.required_actions ?? null },
    executor_connected_after_s: secs(postAt, connected.at),
    turn_outcome_after_connect: typeOf(end),
    original_input_ran_without_resubmit: e1Items.some((i) => str(i.command)?.includes("E1-OK") === true),
    events_in_order: observed.filter((o) => o.stream === "A" && o.n <= end.n).map((o) => typeOf(o)),
  };
  await waitFor((o) => o.stream === "A" && o.n > end.n && typeOf(o) === "agent.session.idle", "E1 idle", 30_000);

  // ─── E2: kill the executor mid-command ─────────────────────────────────
  {
    const before = counter;
    await send(a.id, [message("Run this shell command: sleep 40; echo SURVIVED. Then reply DONE.")]);
    const cmd = await waitFor((o) => o.stream === "A" && o.n > before && typeOf(o) === "agent.session.turn.item.added" && itemType(o) === "command_execution", "E2 command start");
    await delay(5000);
    const killAt = Date.now();
    exec1.child.kill("SIGKILL");
    await exec1.exited;
    const next = await waitFor((o) => o.stream === "A" && o.n > cmd.n && (typeOf(o).startsWith("agent.session.environment.") || isRootTerminal(o) || typeOf(o) === "agent.session.requires_action"), "E2 reaction", 120_000).catch(() => null);
    const terminal = await waitFor((o) => o.stream === "A" && o.n > cmd.n && isRootTerminal(o), "E2 turn end", 90_000).catch(() => null);
    await delay(3000);
    const after = await retrieve(a.id);
    const turn = await http("GET", `${BASE}/agents/sessions/${a.id}/turns/${turnOf(cmd) ?? ""}`);
    const e2Items = await items(a.id);
    findings.E2 = {
      first_reaction: next === null ? "nothing within 120 s" : { type: typeOf(next), after_s: secs(killAt, next.at), environment: next.event.environment ?? null, turn_error: field(next.event, "turn", "error") ?? null },
      turn_terminal: terminal === null ? "none within 90 s" : { type: typeOf(terminal), after_s: secs(killAt, terminal.at), error: field(terminal.event, "turn", "error") ?? null },
      events_after_kill: observed.filter((o) => o.stream === "A" && o.at >= killAt).map((o) => `${typeOf(o)}${itemType(o) === null ? "" : `(${itemType(o) ?? ""})`}`),
      session_after: { status: after.status ?? null, required_actions: after.required_actions ?? null, environment_status: field(after, "environment", "status") ?? null },
      turn_after: { status: turn.json?.status ?? null, error: turn.json?.error ?? null },
      items_of_turn: brief(e2Items.filter((i) => i.turn_id === turnOf(cmd))),
    };
  }

  // ─── E3: replacement executor, same environment id ─────────────────────
  {
    const before = counter;
    const exec2 = startExecutor(a.remoteUrl, a.envId, "oar-probe-2");
    executors.push(exec2);
    const connected2 = await waitFor((o) => o.stream === "A" && o.n > before && typeOf(o) === "agent.session.environment.connected", "E3 connected", 90_000).catch(() => null);
    const afterConnect = await retrieve(a.id);
    let ran: Json | string = "not attempted";
    if (connected2 !== null) {
      const b2 = counter;
      const { status } = afterConnect;
      const post2 = await send(a.id, [message("Run this shell command: echo E3-OK. Then reply DONE.")]);
      const end2 = await waitFor((o) => o.stream === "A" && o.n > b2 && isRootTerminal(o), "E3 turn end", 120_000).catch(() => null);
      const list = await items(a.id);
      ran = { session_status_before_post: status ?? null, post_status: post2.status, outcome: end2 === null ? "no turn end" : typeOf(end2), e3_command_ran: list.some((i) => str(i.command)?.includes("E3-OK") === true), pending_survived_ran: list.filter((i) => str(i.command)?.includes("SURVIVED") === true).map((i) => i.status) };
    }
    findings.E3 = {
      replacement_connected: connected2 !== null,
      connected_event_environment: connected2?.event.environment ?? null,
      session_after_connect: { status: afterConnect.status ?? null, required_actions: afterConnect.required_actions ?? null },
      next_message: ran,
      executor2_log: exec2.log.join("").slice(0, 600),
    };
  }

  // ─── R1: the completed-but-not-idle window, five attempts ──────────────
  {
    const attempts: Json[] = [];
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      attempts.push(await raceAttempt(a.id, i));
    }
    findings.R1 = { attempts, lost: attempts.filter((x) => x.race_turn_started === false).length };
  }

  // ─── E4: delete the session while the executor is connected ────────────
  {
    const exec = executors.at(-1);
    const alive = exec !== undefined && exec.child.exitCode === null;
    const del = await http("DELETE", `${BASE}/agents/sessions/${a.id}`);
    const streamEnded = await Promise.race([streamA.done, delay(10_000).then(() => "still-open" as const)]);
    const exited = exec === undefined ? null : await Promise.race([exec.exited.then((code) => ({ exited: true, code })), delay(15_000).then(() => ({ exited: false, code: null }))]);
    findings.E4 = {
      executor_alive_before_delete: alive,
      delete_status: del.status,
      stream_after_delete: streamEnded,
      executor_within_15s: exited,
      executor_log_tail: exec?.log.join("").slice(-600) ?? null,
    };
    if (streamEnded === "still-open") {
      streamA.abort();
    }
  }
} catch (error) {
  const cause = error instanceof Error && isRecord(error.cause) ? error.cause : null;
  findings.crash = { message: error instanceof Error ? error.message : String(error), cause: cause === null ? null : { code: cause.code ?? null, message: str(cause.message) } };
} finally {
  for (const e of executors) {
    e.child.kill();
  }
  findings.posts = posts;
  findings.deletions = await Promise.all(
    sessionsToDelete.map(async (id) => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await http("DELETE", `${BASE}/agents/sessions/${id}`);
        statuses.push(r.status);
        if (r.status !== 409) {
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await delay(5000);
      }
      return { id, statuses };
    }),
  );
  await writeFile(path.join(outDir, "events.jsonl"), `${observed.map((o) => JSON.stringify(o)).join("\n")}\n`);
  await writeFile(path.join(outDir, "findings.json"), JSON.stringify(findings, null, 2));
  process.stdout.write(`\n${JSON.stringify(findings, null, 2)}\nwrote ${outDir}\n`);
  process.exit(0);
}
