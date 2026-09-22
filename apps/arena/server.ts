/**
 * OAR Arena: two coding agents duel, a browser watches.
 *
 * Run: pnpm arena [--left claude] [--right codex:gpt-5.2] [--port 4747]
 *      pnpm arena --left mock:claude --right mock:codex   (no real turns)
 *
 * The referee (game.ts) is deterministic; each fighter is one oar session
 * that lives for the whole match, so it remembers how its opponent plays.
 * The page gets everything over one SSE stream and is replayed the match so
 * far when it connects late.
 */
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { text as textOf } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { displayName, openFighter, parseFighterSpec, type Fighter, type Reply, type Vitals } from "./fighters.js";
import { MOVE_INFO, RULES, initialMatch, resolveRound, verdictOf, type MatchState, type Side, type Step, type Verdict } from "./game.js";
import { roundPrompt } from "./prompts.js";

const { values: flags } = parseArgs({
  options: {
    left: { type: "string", default: "claude" },
    right: { type: "string", default: "codex" },
    port: { type: "string", default: "4747" },
    /** Seconds a fighter may take before its move is forfeit. */
    timeout: { type: "string", default: "120" },
    /** Milliseconds between rounds, so the page can play the last one out. */
    pace: { type: "string", default: "3500" },
    "taunt-language": { type: "string", default: "Chinese" },
  },
});

const specs = { left: parseFighterSpec(flags.left), right: parseFighterSpec(flags.right) };
const names: Record<Side, string> = { left: displayName(specs.left), right: displayName(specs.right) };
if (names.left === names.right) {
  names.left = `${names.left} A`;
  names.right = `${names.right} B`;
}
const timeoutMs = Number(flags.timeout) * 1000;
const paceMs = Number(flags.pace);
const SIDES = ["left", "right"] as const;

type ArenaEvent =
  | { readonly type: "lobby"; readonly names: Record<Side, string>; readonly rules: typeof RULES; readonly moves: typeof MOVE_INFO }
  | { readonly type: "opening" }
  | { readonly type: "match_start"; readonly fighters: Record<Side, { readonly name: string; readonly icon: string | null }>; readonly state: MatchState }
  | { readonly type: "round_start"; readonly state: MatchState }
  | { readonly type: "thought"; readonly side: Side; readonly text: string }
  | { readonly type: "locked"; readonly side: Side; readonly ms: number }
  | { readonly type: "round_result"; readonly steps: readonly Step[]; readonly replies: Record<Side, Reply>; readonly vitals: Record<Side, Vitals>; readonly state: MatchState }
  | { readonly type: "heckle"; readonly side: Side; readonly text: string; readonly landed: string }
  | { readonly type: "match_end"; readonly verdict: Verdict }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "replay_done" };

const viewers = new Set<ServerResponse>();
/** The current match so far; a page that connects late is replayed it. */
let backlog: ArenaEvent[] = [];
let ring: Record<Side, Fighter> | null = null;
let running = false;

function send(response: ServerResponse, event: ArenaEvent): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function emit(event: ArenaEvent): void {
  backlog.push(event);
  for (const viewer of viewers) {
    send(viewer, event);
  }
}

async function runMatch(): Promise<void> {
  backlog = [];
  emit({ type: "opening" });
  const corner = (side: Side): { name: string; opponent: string; tauntLanguage: string } =>
    ({ name: names[side], opponent: names[side === "left" ? "right" : "left"], tauntLanguage: flags["taunt-language"] });
  const opened = await Promise.allSettled([openFighter(specs.left, corner("left")), openFighter(specs.right, corner("right"))]);
  const [left, right] = opened;
  if (left.status !== "fulfilled" || right.status !== "fulfilled") {
    await Promise.all(opened.map(async (result) => { await (result.status === "fulfilled" ? result.value.dispose() : null); }));
    throw new Error(opened.map((result) => (result.status === "rejected" ? String(result.reason) : "")).filter((reason) => reason !== "").join("; "));
  }
  const fighters = { left: left.value, right: right.value };
  ring = fighters;
  try {
    let state = initialMatch();
    let lastSteps: readonly Step[] = [];
    emit({
      type: "match_start",
      fighters: { left: { name: names.left, icon: fighters.left.icon }, right: { name: names.right, icon: fighters.right.icon } },
      state,
    });
    while (verdictOf(state).kind === "ongoing") {
      emit({ type: "round_start", state });
      const before = state;
      const steps = lastSteps;
      const ask = async (side: Side): Promise<Reply> => {
        const answer = await fighters[side].choose(roundPrompt(side, before, steps, names), (text) => { emit({ type: "thought", side, text }); }, timeoutMs);
        emit({ type: "locked", side, ms: answer.ms });
        return answer;
      };
      // eslint-disable-next-line no-await-in-loop
      const [leftReply, rightReply] = await Promise.all([ask("left"), ask("right")]);
      const resolved = resolveRound(state, { left: leftReply, right: rightReply });
      state = resolved.state;
      lastSteps = resolved.steps;
      emit({
        type: "round_result",
        steps: resolved.steps,
        replies: { left: leftReply, right: rightReply },
        vitals: { left: fighters.left.vitals(), right: fighters.right.vitals() },
        state,
      });
      // eslint-disable-next-line no-await-in-loop
      await delay(paceMs);
    }
    emit({ type: "match_end", verdict: verdictOf(state) });
  } finally {
    ring = null;
    await Promise.allSettled(SIDES.map(async (side) => { await fighters[side].dispose(); }));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startMatch(): boolean {
  if (running) {
    return false;
  }
  running = true;
  void (async (): Promise<void> => {
    try {
      await runMatch();
    } catch (error) {
      emit({ type: "error", message: messageOf(error) });
    } finally {
      running = false;
    }
  })();
  return true;
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const body: unknown = JSON.parse(await textOf(request));
  return body;
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const route = `${request.method ?? "GET"} ${new URL(request.url ?? "/", "http://localhost").pathname}`;
  if (route === "GET /") {
    // Read per request: editing the page needs no restart.
    const page = await readFile(new URL("index.html", import.meta.url));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
  } else if (route === "GET /events") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    send(response, { type: "lobby", names, rules: RULES, moves: MOVE_INFO });
    for (const event of backlog) {
      send(response, event);
    }
    send(response, { type: "replay_done" });
    viewers.add(response);
    request.on("close", () => { viewers.delete(response); });
  } else if (route === "POST /start") {
    reply(response, startMatch() ? 202 : 409, { running: true });
  } else if (route === "POST /heckle") {
    const body = await bodyOf(request);
    const side = typeof body === "object" && body !== null && "side" in body && (body.side === "left" || body.side === "right") ? body.side : null;
    const text = typeof body === "object" && body !== null && "text" in body && typeof body.text === "string" ? body.text.trim().slice(0, 280) : "";
    if (side === null || text === "" || ring === null) {
      reply(response, 400, { error: ring === null ? "no match running" : "need side and text" });
      return;
    }
    const landed = await ring[side].heckle(text);
    emit({ type: "heckle", side, text, landed });
    reply(response, 200, { landed });
  } else {
    reply(response, 404, { error: "not found" });
  }
}

const server = createServer((request, response): void => {
  void (async (): Promise<void> => {
    try {
      await handle(request, response);
    } catch (error) {
      if (!response.headersSent) {
        reply(response, 500, { error: messageOf(error) });
      }
    }
  })();
});

// Loopback only: /start spends real model turns and the sessions behind it run without a sandbox.
server.listen(Number(flags.port), "127.0.0.1", () => {
  process.stdout.write(`OAR Arena: ${names.left} vs ${names.right}\n  http://localhost:${flags.port}\n`);
});

process.on("SIGINT", () => {
  void (async (): Promise<void> => {
    const fighters = ring;
    if (fighters !== null) {
      await Promise.allSettled(SIDES.map(async (side) => { await fighters[side].dispose(); }));
    }
    process.exit(0);
  })();
});
