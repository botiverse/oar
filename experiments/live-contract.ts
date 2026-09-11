/**
 * LIVE CONTRACT BATTERY — the record-stream promises, exercised against a
 * REAL runtime through the public Session API, one scenario at a time, with
 * every scenario's full stream kept as an oar-voyage/2 log.
 *
 * The shared behavior suite (sea-trial/cases) asserts the minimum every
 * backend must honor. This battery asks the stronger questions a scripted
 * provider cannot answer: did the steer land in the same turn, did the queued
 * input run as a spontaneous turn, did the abort produce the runtime's own
 * aborted report, did dispose mid-turn record the exit, do sub-agent frames
 * attribute, does an unrequested process death show up as an `exited`
 * response, does a resumed session recall the transcript. Each scenario
 * records FACTS (what was observed, with record seqs) rather than only
 * pass/fail, so a surprising runtime behavior is evidence, not a red test.
 *
 * Run: pnpm tsx experiments/live-contract.ts <backend> [--model <id>] [--only a,b,c] [--out <dir>]
 *   backend: a real runtime id (claude|codex|grok|kimi|pi — logged in, BURNS
 *   TOKENS) or a sea-trial backend (mock|claude-aimock|codex-aimock|pi-aimock,
 *   zero tokens — for shaking the battery itself, not for evidence).
 * Output: <out>/<scenario>.voyage.jsonl per scenario + <out>/report.json;
 * default out is ./oar-trial-run/live-<backend>-<stamp>/.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  awaitTurnEnd,
  openVoyage,
  turnEndAfter,
  type ControlResult,
  type Session,
  type SessionOptions,
  type RequestRecord,
  type ResponseRecord,
  type SessionRecord,
  type VoyageRecorder,
} from "../packages/oar/src/index.js";
import { selectBackend } from "../sea-trial/harness/backends.js";

// ─── arguments ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const [backendId] = argv;
if (backendId === undefined || backendId.startsWith("--")) {
  process.stderr.write("usage: pnpm tsx experiments/live-contract.ts <backend> [--model <id>] [--only a,b] [--out <dir>]\n");
  process.exit(2);
}
function flag(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}
const runtimeId = backendId.replace(/-aimock$/u, "");
const DEFAULT_MODEL: Record<string, string> = {
  claude: "haiku",
  codex: "gpt-5.3-codex-spark",
  pi: "openai-codex/gpt-5.3-codex-spark",
};
const model = flag("--model") ?? (backendId.endsWith("-aimock") || backendId === "mock" ? undefined : DEFAULT_MODEL[runtimeId]);
const only = flag("--only")?.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
const stamp = new Date().toISOString().replaceAll(":", "-");
const outDir = flag("--out") ?? path.join(process.cwd(), "oar-trial-run", `live-${backendId}-${stamp}`);
mkdirSync(outDir, { recursive: true });

const backend = await selectBackend(backendId);
const { runtime } = backend;
const probe = runtime.installation;
if (probe === undefined) {
  throw new Error(`${runtime.id} has no installation probe`);
}
const probed = await probe();
if (probed.kind !== "available") {
  throw new Error(`${runtime.id} is not available: ${probed.kind}`);
}
const installation = probed;
if (runtimeId === "pi") {
  delete process.env.PI_PACKAGE_DIR;
}

// ─── helpers ──────────────────────────────────────────────────────────────

type Facts = Record<string, unknown>;
interface ScenarioResult {
  readonly id: string;
  readonly status: "pass" | "fail" | "skip" | "timeout" | "error";
  readonly facts: Facts;
  readonly notes: string[];
  readonly voyage: string;
  readonly ms: number;
}

class ScenarioFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioFailureError";
  }
}

function fail(message: string): never {
  throw new ScenarioFailureError(message);
}

const SCENARIO_TIMEOUT_MS = 300_000;

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  const { promise: bound, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    reject(new Error(`timeout after ${String(ms)}ms: ${what}`));
  }, ms);
  try {
    return await Promise.race([work, bound]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(predicate: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timeout after ${String(ms)}ms waiting for ${what}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(100);
  }
}

/** Root-session, root-agent text views after `seq` (up to and including the first turn_ended when `untilEnd`). */
function rootText(session: Session, afterSeq: number, untilEnd = true): string {
  const parts: string[] = [];
  const own = session.records().filter((record) =>
    record.seq > afterSeq && record.kind === "event" && record.sessionId === session.id && record.agentPath.length === 0);
  for (const record of own) {
    let ended = false;
    for (const view of record.kind === "event" ? record.body.views : []) {
      if (view.kind === "text_delta") {
        parts.push(view.text);
      }
      if (view.kind === "turn_ended") {
        ended = true;
      }
    }
    if (ended && untilEnd) {
      break;
    }
  }
  return parts.join("");
}

function rootTurnEnds(session: Session, afterSeq = -1): readonly SessionRecord[] {
  return session.records().filter((record) =>
    record.seq > afterSeq && record.kind === "event" && record.sessionId === session.id
    && record.agentPath.length === 0 && record.body.views.some((view) => view.kind === "turn_ended"));
}

function toolStartedAfter(session: Session, afterSeq: number): boolean {
  return session.records().some((record) =>
    record.seq > afterSeq && record.kind === "event" && record.body.views.some((view) => view.kind === "tool_call_started"));
}

function describeRecord(record: SessionRecord): string {
  if (record.kind === "event") {
    const views = record.body.views.map((view) => view.kind).join(",");
    return `${record.body.type}${views === "" ? "" : ` → ${views}`}`;
  }
  return `${record.kind} ${record.body.kind}`;
}

function accepted(result: ControlResult, what: string): ControlResult {
  if (result.response.body.kind !== "accepted") {
    fail(`${what} not accepted: ${JSON.stringify(result.response.body)}`);
  }
  return result;
}

/** How to ask each runtime for a shell command, in its own vocabulary. */
function shell(command: string): string {
  switch (runtimeId) {
    case "claude":
      return `Use the Bash tool to run exactly: ${command}`;
    case "codex":
      return `Run this shell command: ${command}`;
    case "pi":
      return `Use the bash tool to run exactly: ${command}`;
    default:
      return `Use your shell tool to run exactly: ${command}`;
  }
}

const LONG_LOOP = "for i in $(seq 1 40); do sleep 1; done; echo NEVER";

/** Message plus any structured `data` an RPC error carries (kimi puts the useful text there). */
function errorFacts(error: unknown): { message: string; data?: unknown } {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const data: unknown = "data" in error ? error.data : undefined;
  return data === undefined ? { message: error.message } : { message: error.message, data };
}

/** The runtime's own PID for this session's process (subprocess runtimes only): the child of this process whose command names the runtime. */
function runtimePid(): number | null {
  const table = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  const mine = new RegExp(`\\b${runtimeId}\\b`, "u");
  for (const line of table.split("\n")) {
    const match = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<command>.*)$/u.exec(line);
    const groups = match?.groups;
    if (groups !== undefined && Number(groups.ppid) === process.pid && mine.test(groups.command ?? "")) {
      return Number(groups.pid);
    }
  }
  return null;
}

// ─── scenarios ────────────────────────────────────────────────────────────

interface Scenario {
  readonly id: string;
  readonly skip?: () => string | null;
  readonly run: (open: (options?: Partial<SessionOptions>) => Promise<Session>, facts: Facts, notes: string[]) => Promise<void>;
}

const scenarios: Scenario[] = [
  {
    id: "basic",
    async run(open, facts) {
      const session = await open();
      const result = accepted(await session.prompt("Reply with exactly the word PLUM and nothing else."), "prompt");
      const outcome = await awaitTurnEnd(session, result.request.seq);
      const records = session.records();
      const text = rootText(session, result.request.seq);
      facts.outcome = outcome;
      facts.text = text.slice(0, 200);
      facts.recordCount = records.length;
      facts.eventTypes = [...new Set(records.flatMap((record) => (record.kind === "event" ? [record.body.type] : [])))];
      facts.viewKinds = [...new Set(records.flatMap((record) => (record.kind === "event" ? record.body.views.map((view) => view.kind) : [])))];
      facts.everyEventHasNative = records.every((record) => record.kind !== "event" || (record.body.native !== undefined && record.body.native !== null));
      facts.spanIds = new Set(records.flatMap((record) => (record.spanId === undefined ? [] : [record.spanId]))).size;
      facts.seqDense = records.every((record, index) => record.seq === index);
      facts.model = session.model();
      facts.usage = session.usage();
      facts.usageTokensNonZero = (session.usage().total?.input ?? 0) > 0;
      facts.contextUsage = session.contextUsage();
      facts.capabilities = session.capabilities;
      facts.recordsBeforeOpen = records.findIndex((record) => record.kind === "event" && record.body.views.some((view) => view.kind === "model"));
      await session.dispose();
      facts.tail = session.records().slice(-3).map((record) => describeRecord(record));
      const dispose = session.records().find((record): record is RequestRecord => record.kind === "request" && record.body.kind === "dispose");
      const exit = session.records().find((record): record is ResponseRecord => record.kind === "response" && dispose !== undefined && record.requestId === dispose.id);
      facts.disposeAnswer = exit?.kind === "response" ? exit.body : null;
      if (outcome.kind !== "completed") {
        fail(`turn ${JSON.stringify(outcome)}`);
      }
      if (!text.includes("PLUM")) {
        fail(`reply did not contain PLUM: ${JSON.stringify(text)}`);
      }
      if (exit === undefined) {
        fail("dispose request was not answered");
      }
    },
  },
  {
    id: "multi-turn",
    async run(open, facts) {
      const session = await open();
      const usages: unknown[] = [];
      const ends: number[] = [];
      for (const word of ["ONE", "TWO", "THREE"]) {
        // eslint-disable-next-line no-await-in-loop
        const result = accepted(await session.prompt(`Reply with exactly the word ${word}.`), `prompt ${word}`);
        // eslint-disable-next-line no-await-in-loop
        const outcome = await awaitTurnEnd(session, result.request.seq);
        if (outcome.kind !== "completed") {
          fail(`turn ${word}: ${JSON.stringify(outcome)}`);
        }
        ends.push(rootTurnEnds(session, result.request.seq).length);
        usages.push({ usage: session.usage(), context: session.contextUsage() });
      }
      facts.turnEndsPerTurn = ends;
      facts.usageAfterEachTurn = usages;
      facts.promptRequests = session.records().filter((record) => record.kind === "request" && record.body.kind === "prompt").length;
      facts.seqDense = session.records().every((record, index) => record.seq === index);
      await session.dispose();
      if (ends.some((count) => count !== 1)) {
        fail(`each turn must end exactly once: ${JSON.stringify(ends)}`);
      }
    },
  },
  {
    id: "tool-detail",
    async run(open, facts) {
      const session = await open();
      const result = accepted(await session.prompt(`${shell("echo TOOL-MARK-4412")}. Then reply with exactly the printed line.`), "prompt");
      const outcome = await awaitTurnEnd(session, result.request.seq);
      const views = session.records().filter((record) => record.seq > result.request.seq && record.kind === "event").flatMap((record) => (record.kind === "event" ? record.body.views : []));
      const started = views.filter((view) => view.kind === "tool_call_started");
      const ended = views.filter((view) => view.kind === "tool_call_ended");
      facts.outcome = outcome;
      const startedViews = views.flatMap((view) => (view.kind === "tool_call_started" ? [view] : []));
      const endedViews = views.flatMap((view) => (view.kind === "tool_call_ended" ? [view] : []));
      facts.toolCalls = startedViews.map((view) => ({ tool: view.tool, callId: view.callId, inputHasCommand: view.input?.includes("TOOL-MARK-4412") ?? false, input: view.input?.slice(0, 120) }));
      facts.toolEnds = endedViews.map((view) => ({ callId: view.callId, outputHasMarker: view.output?.includes("TOOL-MARK-4412") ?? false, output: view.output?.slice(0, 120) }));
      facts.callIdsMatch = startedViews.every((start) => endedViews.some((end) => end.callId === start.callId));
      facts.reasoningViews = views.flatMap((view) => (view.kind === "reasoning" ? [view.content.kind] : [])).slice(0, 10);
      facts.text = rootText(session, result.request.seq).slice(0, 200);
      await session.dispose();
      if (started.length === 0 || ended.length === 0) {
        fail("no tool call framing observed");
      }
      if (outcome.kind !== "completed") {
        fail(`turn ${JSON.stringify(outcome)}`);
      }
    },
  },
  {
    id: "busy-and-late-control",
    async run(open, facts) {
      const session = await open();
      const first = accepted(await session.prompt(`${shell("sleep 6; echo SLOW-DONE")}. Then reply with exactly DONE-1.`), "prompt");
      const second = await session.prompt("Reply with exactly TWO.");
      facts.secondPrompt = second.response.body;
      const outcome = await awaitTurnEnd(session, first.request.seq);
      facts.outcome = outcome;
      const lateAbort = await session.abort();
      const lateSteer = await session.steer("too late");
      facts.lateAbort = lateAbort.response.body;
      facts.lateSteer = lateSteer.response.body;
      facts.rootTurnEnds = rootTurnEnds(session).length;
      await session.dispose();
      if (second.response.body.kind !== "rejected") {
        fail("second prompt during an active turn was not rejected");
      }
      if (lateAbort.response.body.kind !== "rejected" || lateSteer.response.body.kind !== "rejected") {
        fail("late abort/steer must be rejected");
      }
    },
  },
  {
    id: "steer",
    async run(open, facts, notes) {
      const session = await open();
      if (!session.capabilities.steer) {
        const result = accepted(await session.prompt(`${shell("sleep 4; echo A")}. Then reply DONE.`), "prompt");
        const steer = await session.steer("Also append the word MANGO.");
        facts.steer = steer.response.body;
        await awaitTurnEnd(session, result.request.seq);
        await session.dispose();
        notes.push("runtime declares steer: false; verified the rejection only");
        if (steer.response.body.kind !== "rejected") {
          fail("steer must be rejected when capabilities.steer is false");
        }
        return;
      }
      const result = accepted(await session.prompt([
        shell("sleep 5; echo ALPHA"), "then, as a SECOND separate tool call,", shell("sleep 5; echo BRAVO").replace(/^Use|^Run/u, (word) => word.toLowerCase()),
        ". Then reply with exactly the two printed words in order plus any extra words I ask for later.",
      ].join(" ")), "prompt");
      await waitUntil(() => toolStartedAfter(session, result.request.seq), 120_000, "first tool call");
      const steer = await session.steer("Also append the word MANGO to your final reply.");
      facts.steer = steer.response.body;
      facts.steerSeq = steer.request.seq;
      const outcome = await awaitTurnEnd(session, result.request.seq);
      const sameTurnText = rootText(session, result.request.seq);
      facts.outcome = outcome;
      facts.sameTurnText = sameTurnText.slice(0, 300);
      facts.landedSameTurn = sameTurnText.includes("MANGO");
      if (!sameTurnText.includes("MANGO")) {
        // A late steer may run as a spontaneous next turn; give it a moment.
        await delay(15_000);
        facts.laterTurnEnds = rootTurnEnds(session, result.request.seq).length;
        facts.laterText = rootText(session, result.request.seq, false).slice(0, 300);
      }
      await session.dispose();
      if (steer.response.body.kind !== "accepted") {
        fail(`steer not accepted: ${JSON.stringify(steer.response.body)}`);
      }
      if (outcome.kind !== "completed") {
        fail(`turn ${JSON.stringify(outcome)}`);
      }
    },
  },
  {
    id: "queue",
    async run(open, facts, notes) {
      const session = await open();
      const result = accepted(await session.prompt(`${shell("sleep 6; echo SLOW-DONE")}. Then reply with exactly DONE-1.`), "prompt");
      if (session.capabilities.queue === null) {
        const refused = await session.queue("Reply with exactly ok-q.");
        facts.queue = refused.response.body;
        await awaitTurnEnd(session, result.request.seq);
        await session.dispose();
        notes.push("runtime declares no queue; verified the rejection only");
        return;
      }
      await waitUntil(() => toolStartedAfter(session, result.request.seq), 120_000, "tool call");
      const queued = await session.queue("Reply with exactly ok-q and nothing else.");
      facts.queue = queued.response.body;
      facts.durable = session.capabilities.queue.durable;
      const outcome = await awaitTurnEnd(session, result.request.seq);
      facts.firstOutcome = outcome;
      const firstEndSeq = rootTurnEnds(session, result.request.seq)[0]?.seq ?? result.request.seq;
      await waitUntil(() => rootTurnEnds(session, firstEndSeq).length > 0, 120_000, "the queued turn to end");
      facts.spontaneousTurnEnded = true;
      facts.promptRequestsAfterFirst = session.records().filter((record) => record.seq > firstEndSeq && record.kind === "request" && record.body.kind === "prompt").length;
      facts.queuedText = rootText(session, firstEndSeq).slice(0, 200);
      await session.dispose();
      if (!rootText(session, firstEndSeq).includes("ok-q")) {
        fail("queued input did not run as the next turn");
      }
    },
  },
  {
    id: "abort",
    async run(open, facts) {
      const session = await open();
      const result = accepted(await session.prompt(`${shell(LONG_LOOP)}. Then reply done.`), "prompt");
      await waitUntil(() => toolStartedAfter(session, result.request.seq), 120_000, "tool call");
      await delay(2000);
      const abort = await withTimeout(session.abort(), 60_000, "abort()");
      facts.abort = abort.response.body;
      facts.abortAnswerHasNative = abort.response.body.kind === "accepted" && abort.response.body.native !== undefined;
      const outcome = await withTimeout(awaitTurnEnd(session, result.request.seq), 60_000, "turn end after abort");
      facts.outcome = outcome;
      const endSeq = rootTurnEnds(session, result.request.seq)[0]?.seq ?? -1;
      facts.acceptedBeforeTurnEnd = endSeq === -1 ? null : abort.response.seq < endSeq;
      const late = await session.abort();
      facts.lateAbort = late.response.body;
      facts.tail = session.records().slice(-4).map((record) => describeRecord(record));
      await session.dispose();
      if (abort.response.body.kind !== "accepted") {
        fail(`abort not accepted: ${JSON.stringify(abort.response.body)}`);
      }
      if (outcome.kind !== "aborted") {
        fail(`expected the runtime's own aborted report, got ${JSON.stringify(outcome)}`);
      }
      if (late.response.body.kind !== "rejected") {
        fail("late abort must be rejected");
      }
    },
  },
  {
    id: "dispose-mid-turn",
    async run(open, facts) {
      const session = await open();
      const result = accepted(await session.prompt(`${shell(LONG_LOOP)}. Then reply done.`), "prompt");
      await waitUntil(() => toolStartedAfter(session, result.request.seq), 120_000, "tool call");
      await withTimeout(session.dispose(), 60_000, "dispose()");
      const records = session.records();
      const dispose = records.find((record): record is RequestRecord => record.kind === "request" && record.body.kind === "dispose");
      const answer = records.find((record): record is ResponseRecord => record.kind === "response" && dispose !== undefined && record.requestId === dispose.id);
      facts.tail = records.slice(-5).map((record) => describeRecord(record));
      facts.disposeAnswer = answer?.kind === "response" ? answer.body : null;
      facts.turnEndAfterPrompt = turnEndAfter(records, result.request.seq, session.id);
      const after = await session.prompt("after dispose");
      facts.promptAfterDispose = after.response.body;
      if (answer === undefined) {
        fail("dispose was not answered");
      }
      if (after.response.body.kind !== "rejected") {
        fail("a disposed session must reject control");
      }
    },
  },
  {
    id: "cursor",
    async run(open, facts) {
      const session = await open();
      const result = accepted(await session.prompt(`${shell("sleep 3; echo CUR")}. Then reply with exactly CURSOR-OK.`), "prompt");
      await delay(500);
      const seen: number[] = [];
      session.subscribe((record) => {
        seen.push(record.seq);
      }, { sessionId: session.id, afterSeq: result.request.seq });
      const replayedCount = seen.length;
      const outcome = await awaitTurnEnd(session, result.request.seq);
      await delay(300);
      const expected = session.records().filter((record) => record.seq > result.request.seq).map((record) => record.seq);
      facts.replayedCount = replayedCount;
      facts.liveCount = seen.length - replayedCount;
      facts.contiguous = JSON.stringify(seen) === JSON.stringify(expected);
      const fromStart: number[] = [];
      session.subscribe((record) => {
        fromStart.push(record.seq);
      }, { sessionId: session.id, afterSeq: -1 });
      facts.fullReplayMatchesLog = JSON.stringify(fromStart) === JSON.stringify(session.records().map((record) => record.seq));
      facts.outcome = outcome;
      await session.dispose();
      if (facts.contiguous !== true || facts.fullReplayMatchesLog !== true) {
        fail("cursor replay and live delivery disagree with the retained log");
      }
    },
  },
  {
    id: "resume",
    async run(open, facts) {
      const first = await open();
      const taught = accepted(await first.prompt("Remember this codeword: PLUM-42. Reply with exactly ok."), "prompt");
      const taughtOutcome = await awaitTurnEnd(first, taught.request.seq);
      facts.firstModel = first.model();
      await first.dispose();
      const resumed = await open({ resume: first.id });
      const sameId = resumed.id === first.id;
      facts.sameId = sameId;
      facts.firstSeqOfResumedStream = resumed.records()[0]?.seq ?? null;
      facts.recordsAtOpen = resumed.records().map((record) => describeRecord(record));
      facts.resumedModelAtOpen = resumed.model();
      const asked = accepted(await resumed.prompt("What was the codeword I told you earlier? Reply with exactly it."), "prompt after resume");
      const outcome = await awaitTurnEnd(resumed, asked.request.seq);
      const text = rootText(resumed, asked.request.seq);
      facts.recalledText = text.slice(0, 200);
      facts.recalled = text.includes("PLUM-42");
      facts.resumedModel = resumed.model();
      facts.outcome = outcome;
      await resumed.dispose();
      if (taughtOutcome.kind !== "completed" || outcome.kind !== "completed") {
        fail("a turn did not complete");
      }
      if (!sameId) {
        fail("resumed session id differs");
      }
      if (!text.includes("PLUM-42")) {
        fail(`resumed session did not recall the codeword: ${JSON.stringify(text)}`);
      }
    },
  },
  {
    id: "subagent",
    skip: () => (runtimeId === "pi" || runtimeId === "mock" ? "no native sub-agents" : null),
    async run(open, facts, notes) {
      const session = await open();
      const ask: Record<string, string> = {
        claude: "Use the Task tool to launch exactly one subagent (subagent_type general-purpose) whose only job is to run the shell command `echo CHILD-OK-7731` and report the printed line back to you. Do not run the command yourself. When it reports back, reply with exactly the line it reported.",
        codex: "You have a sub-agent (spawn_agent / collaboration) tool. Spawn exactly one sub-agent whose only job is to run the shell command `echo CHILD-OK-7731` and report the printed line back to you. Wait for it to finish, then reply with exactly the line it reported. Do not run the command yourself.",
        grok: "Use your task tool (spawn_subagent) with subagent_type general-purpose and run_in_background false to launch exactly one sub-agent whose only job is to run the shell command `echo CHILD-OK-7731` and report the printed line back to you. Do not run the command yourself. When it reports back, reply with exactly the line it reported.",
        kimi: "Use the Agent tool to delegate to exactly one sub-agent whose only job is to run the shell command `echo CHILD-OK-7731` and report the printed line back to you. Do not run the command yourself. When it reports back, reply with exactly the line it reported.",
      };
      const prompt = ask[runtimeId] ?? ask.claude ?? "";
      const result = accepted(await session.prompt(prompt), "prompt");
      const outcome = await withTimeout(awaitTurnEnd(session, result.request.seq), 240_000, "root turn end");
      await delay(3000);
      const records = session.records();
      const childPaths = [...new Set(records.filter((record) => record.agentPath.length > 0).map((record) => record.agentPath.join("/")))];
      const childSessions = [...new Set(records.filter((record) => record.sessionId !== session.id).map((record) => record.sessionId))];
      const knownViewless = new Set<string>();
      const typesByOrigin: Record<string, number> = {};
      const originOf = (record: SessionRecord): string => {
        if (record.sessionId !== session.id) {
          return "childSession";
        }
        return record.agentPath.length === 0 ? "root" : "agentPath";
      };
      for (const record of records) {
        if (record.kind === "event") {
          const key = `${originOf(record)}:${record.body.type}`;
          typesByOrigin[key] = (typesByOrigin[key] ?? 0) + 1;
          if (record.body.views.length === 0) {
            knownViewless.add(record.body.type);
          }
        }
      }
      facts.outcome = outcome;
      facts.rootText = rootText(session, result.request.seq).slice(0, 200);
      facts.childAgentPaths = childPaths;
      facts.childSessionIds = childSessions.map((id) => id.slice(0, 12));
      facts.graph = session.graph();
      facts.graphEdges = session.graph().edges.length;
      facts.eventTypesByOrigin = typesByOrigin;
      facts.toAppRequests = records.filter((record) => record.kind === "request" && record.direction === "toApp").map((record) => (record.kind === "request" && record.body.kind === "native" ? record.body.type : "")).slice(0, 10);
      facts.usage = session.usage();
      facts.tier = session.capabilities.attribution;
      // Sub-agent linkage as the runtime spells it: any frame carrying a parent/child pair.
      const linkageFrames = records.filter((record) => record.kind === "event" && /parent_session_id|parentSessionId|child_session_id|childSessionId|subagent_spawned|subagent_finished|parent_tool_use_id|parentThreadId|receiverThreadIds/u.test(JSON.stringify(record.body.native))).slice(0, 6);
      facts.linkageFrames = linkageFrames.map((record) => (record.kind === "event" ? { seq: record.seq, type: record.body.type, native: JSON.stringify(record.body.native).slice(0, 400) } : null));
      await session.dispose();
      if (outcome.kind !== "completed") {
        fail(`turn ${JSON.stringify(outcome)}`);
      }
      const tier = session.capabilities.attribution;
      if (tier === "attributed" && childPaths.length === 0) {
        notes.push("declared attributed but no agentPath records observed — check linkageFrames");
      }
      if (tier === "nested" && childSessions.length === 0) {
        notes.push("declared nested but no child-session records observed — check linkageFrames");
      }
      if (tier === "nested" && childSessions.length > 0 && session.graph().edges.length === 0) {
        fail("declared nested, child session seen, but no lineage edge was linked");
      }
      if (tier === "opaque" && (childPaths.length > 0 || childSessions.length > 0)) {
        notes.push("declared opaque but child records observed — the declaration is too weak");
      }
    },
  },
  {
    id: "kill-runtime",
    skip: () => (runtimeId === "pi" || runtimeId === "mock" ? "in-process runtime, no process to kill" : null),
    async run(open, facts) {
      const session = await open();
      const result = accepted(await session.prompt(`${shell(LONG_LOOP)}. Then reply done.`), "prompt");
      await waitUntil(() => toolStartedAfter(session, result.request.seq), 120_000, "tool call");
      const pid = runtimePid();
      facts.pid = pid;
      if (pid === null) {
        fail("could not find the runtime's process among this process's children");
      }
      process.kill(pid, "SIGKILL");
      await waitUntil(() => session.records().some((record) => record.kind === "response" && record.body.kind === "exited"), 30_000, "the exited response");
      const exit = session.records().find((record) => record.kind === "response" && record.body.kind === "exited");
      facts.exited = exit?.kind === "response" ? { requestId: exit.requestId, body: exit.body } : null;
      facts.turnEndAfterPrompt = turnEndAfter(session.records(), result.request.seq, session.id);
      facts.tail = session.records().slice(-4).map((record) => describeRecord(record));
      const after = await session.prompt("after death");
      facts.promptAfterDeath = after.response.body;
      await withTimeout(session.dispose(), 30_000, "dispose after death");
      facts.disposeTail = session.records().slice(-2).map((record) => describeRecord(record));
      const lateDispose = session.records().find((record): record is RequestRecord => record.kind === "request" && record.body.kind === "dispose");
      facts.lateDisposeAnswered = lateDispose !== undefined && session.records().some((record) => record.kind === "response" && record.requestId === lateDispose.id);
      if (exit?.kind === "response" && exit.requestId !== "") {
        fail("an unrequested exit must not point at a request");
      }
      if (facts.lateDisposeAnswered !== true) {
        fail("a dispose after the runtime died must still be answered");
      }
      if (after.response.body.kind !== "rejected") {
        fail("control after the runtime died must be rejected");
      }
    },
  },
  {
    id: "bad-model",
    skip: () => (backendId === "mock" ? "mock ignores model" : null),
    async run(open, facts) {
      // pi models are spelled provider/model and the adapter checks the spelling
      // before pi sees it; a provider-qualified unknown id reaches pi's plane.
      const unknownModel = runtimeId === "pi" ? `${(model ?? "openai-codex/x").split("/")[0] ?? "openai-codex"}/oar-no-such-model-xyz` : "oar-no-such-model-xyz";
      const attempt = await open({ model: unknownModel }).then(
        (session) => ({ kind: "opened" as const, session }),
        (error: unknown) => ({ kind: "threw" as const, error: errorFacts(error) }),
      );
      if (attempt.kind === "threw") {
        facts.open = attempt.error;
        return;
      }
      const { session } = attempt;
      facts.open = "opened";
      facts.modelReadback = session.model();
      const result = await session.prompt("Reply with exactly ok.");
      facts.prompt = result.response.body;
      if (result.response.body.kind === "accepted") {
        const outcome = await withTimeout(awaitTurnEnd(session, result.request.seq), 120_000, "turn end");
        facts.outcome = outcome;
      }
      await session.dispose();
    },
  },
];

// ─── runner ───────────────────────────────────────────────────────────────

const results: ScenarioResult[] = [];
const openSessions = new Set<Session>();

function statusOf(error: unknown): ScenarioResult["status"] {
  if (error instanceof ScenarioFailureError) {
    return "fail";
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("timeout") ? "timeout" : "error";
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const reason = scenario.skip?.() ?? null;
  const voyagePath = path.join(outDir, `${scenario.id}.voyage.jsonl`);
  if (reason !== null) {
    return { id: scenario.id, status: "skip", facts: {}, notes: [reason], voyage: "", ms: 0 };
  }
  const facts: Facts = {};
  const notes: string[] = [];
  const started = Date.now();
  const recording: { current: VoyageRecorder | null; unsubscribe: (() => void)[] } = { current: null, unsubscribe: [] };
  const open = async (options: Partial<SessionOptions> = {}): Promise<Session> => {
    const session = await runtime.session(installation, {
      cwd: process.cwd(),
      ...(model === undefined ? {} : { model }),
      ...(backend.aimock?.env === undefined ? {} : { env: backend.aimock.env }),
      ...options,
    });
    openSessions.add(session);
    recording.current ??= openVoyage(voyagePath, {
      runtime: runtime.id,
      ...(model === undefined ? {} : { model }),
      cwd: process.cwd(),
      sessionId: session.id,
      startedAt: started,
      recorder: "experiments/live-contract.ts",
    });
    const log = recording.current;
    recording.unsubscribe.push(session.subscribe((record) => {
      log.record(record);
    }, { sessionId: session.id, afterSeq: -1 }));
    return session;
  };
  let status: ScenarioResult["status"] = "pass";
  try {
    await withTimeout(scenario.run(open, facts, notes), SCENARIO_TIMEOUT_MS, scenario.id);
  } catch (error) {
    status = statusOf(error);
    notes.push(error instanceof Error ? error.message : String(error));
  } finally {
    await Promise.all([...openSessions].map(async (session) => {
      await session.dispose().catch(() => {});
    }));
    openSessions.clear();
    // Detach before closing the file: a late record (a terminal host answering
    // after the exit) must not land in the next scenario's reused descriptor.
    for (const off of recording.unsubscribe.splice(0)) {
      off();
    }
    recording.current?.end(status);
  }
  return { id: scenario.id, status, facts, notes, voyage: voyagePath, ms: Date.now() - started };
}

for (const scenario of scenarios) {
  if (only === undefined || only.includes(scenario.id)) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runScenario(scenario);
    results.push(result);
    const suffix = result.notes.length === 0 ? "" : ` — ${result.notes.join(" | ")}`;
    process.stdout.write(`${result.status.toUpperCase().padEnd(7)} ${result.id} (${String(Math.round(result.ms / 1000))}s)${suffix}\n`);
  }
}

const report = {
  backend: backendId,
  runtime: runtime.id,
  version: installation.via === "executable" ? (installation.version ?? null) : "bundled",
  model: model ?? null,
  startedAt: stamp,
  results,
};
writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`report: ${path.join(outDir, "report.json")}\n`);
await backend.aimock?.stop();
process.exit(results.some((result) => result.status === "fail" || result.status === "error" || result.status === "timeout") ? 1 : 0);
