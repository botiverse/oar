/**
 * CRASH AND RESUME: what survives when a runtime's process tree dies in the
 * middle of a tool call, and the host reopens the conversation by its native
 * id.
 *
 * Why: OAR resumes conversations, not execution (docs/runtimes/pi.md). A host
 * deciding what to tell a user after a crash needs, per runtime: is the
 * admitted prompt still there, is the partial answer, what does the model see
 * for the interrupted tool call, does a steer or a queued input the runtime
 * accepted but the model never read survive, and does anything continue on its
 * own after the reopen. Pi Durable names these questions; this measures the
 * answers for runtimes whose loop OAR does not own.
 *
 * Shape: the orchestrator runs phase one in a child process: open, prompt a
 * turn that says ALPHA-TEXT and starts `sleep 45`, wait until the tool call is
 * running, steer (PELICAN) and queue (OSPREY), then report ready. The
 * orchestrator SIGKILLs the child and every descendant at once (container
 * restart, OOM of the whole tree), checks the sleep never finished, and runs
 * phase two in a fresh child: reopen with `resume`, watch 20 s for anything
 * spontaneous, then ask the model, tools forbidden, what it has.
 *
 * Run: pnpm tsx experiments/crash-resume.ts <claude|codex|pi> [--out <dir>]
 * CRASH_RESUME_COMMAND replaces the shell command (it must write crash-marker.txt when it ends);
 * CRASH_RESUME_WATCH_MS sets how long phase two watches before it prompts (default 20000).
 * Burns tokens for two or three short turns; writes two oar-voyage/3 logs and
 * a facts.json. The native transcript is read separately (see the runtime doc).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openVoyage, promptAndWait, runtimes, type Session } from "../packages/oar/src/index.js";

// claude 2.1.284 refuses a foreground `sleep 45` and runs it in the background; a python sleep stays in the foreground.
const COMMAND = process.env.CRASH_RESUME_COMMAND ?? "sleep 45 && echo SLEPT > crash-marker.txt";
const PROMPT =
  "First write one short sentence that contains the word ALPHA-TEXT. Then use your shell tool to run exactly this command: " +
  `${COMMAND} . After it finishes, reply with exactly BETA-DONE.`;
const STEER = "STEER-MARK: when you next reply, include the word PELICAN.";
const QUEUE = "QUEUE-MARK: reply with exactly the word OSPREY.";
const QUESTIONS =
  "Do not run any tools. Answer from this conversation only, briefly: " +
  "(1) Quote verbatim, in order, every user message you have received before this one. " +
  "(2) Quote verbatim the last text you wrote before this message. " +
  "(3) Did your last shell command return a result? If you have one, quote it verbatim; otherwise say NO RESULT.";

type Phase = "phase1" | "phase2";

/** One run: the runtime, the session's working directory, and the output directory. */
interface Run { readonly runtime: string; readonly cwd: string; readonly out: string }

function voyageFor(session: Session, run: Run, name: string): void {
  const header = { runtime: run.runtime, cwd: run.cwd, sessionId: session.id, startedAt: Date.now(), recorder: "experiments/crash-resume.ts" };
  const log = openVoyage(path.join(run.out, name), header);
  session.rawEvents((record) => {
    log.record(record);
  }, { sessionId: session.id, afterSeq: -1 });
}

async function open(runtimeId: string, cwd: string, resume?: string): Promise<Session> {
  const runtime = runtimes.require(runtimeId);
  const installation = await runtime.installation?.();
  assert.ok(installation?.kind === "available", `${runtimeId} is not available`);
  return runtime.session(installation, resume === undefined ? { cwd } : { cwd, resume });
}

function toolRunning(session: Session, afterSeq: number): boolean {
  return session.records().some((record) => record.seq > afterSeq && record.kind === "frame" && record.body.events.some((event) => event.kind === "tool_call_started"));
}

async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, what);
    // oxlint-disable-next-line no-await-in-loop -- polling one condition
    await delay(200);
  }
}

async function phaseOne(run: Run): Promise<void> {
  const { out } = run;
  const session = await open(run.runtime, run.cwd);
  writeFileSync(path.join(out, "session-id"), session.id);
  voyageFor(session, run, "phase1.voyage.jsonl");
  const prompted = await session.prompt(PROMPT);
  assert.equal(prompted.response.body.kind, "accepted");
  await until(() => toolRunning(session, prompted.request.seq), 180_000, "no tool call started within 180 s");
  await delay(4000);
  if (session.steer === undefined) {
    throw new Error(`${run.runtime} has no steer`);
  }
  const steered = await session.steer(STEER);
  const queued = await session.queue(QUEUE);
  await delay(4000);
  const controls = { steer: steered.response.body, queue: queued.response.body };
  writeFileSync(path.join(out, "phase1.json"), JSON.stringify({ sessionId: session.id, controls }, null, 2));
  writeFileSync(path.join(out, "ready"), "");
  await delay(600_000);
}

async function phaseTwo(run: Run): Promise<void> {
  const { out } = run;
  const resume = readFileSync(path.join(out, "session-id"), "utf8");
  const session = await open(run.runtime, run.cwd, resume);
  voyageFor(session, run, "phase2.voyage.jsonl");
  // CRASH_RESUME_WATCH_MS=0 prompts at once, racing whatever the runtime does by itself on reopen.
  await delay(Number(process.env.CRASH_RESUME_WATCH_MS ?? "20000"));
  // Frames the runtime produced before anyone prompted it: a turn, a reply, a tool, a task closing.
  const unprompted = new Set(["user_message", "text_delta", "tool_call_started", "turn_ended", "task_ended"]);
  const spontaneous = session.records().filter((record) => record.kind === "frame" && record.body.events.some((event) => unprompted.has(event.kind))).length;
  const answer = await promptAndWait(session, QUESTIONS, { timeoutMs: 240_000 });
  const text = answer.kind === "rejected" ? `rejected: ${answer.reason}` : answer.text;
  writeFileSync(path.join(out, "phase2.json"), JSON.stringify({ resumedId: session.id, spontaneousFrames: spontaneous, outcome: answer.kind, text }, null, 2));
  await session.dispose();
}

function descendants(root: number): number[] {
  const table = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).map(Number));
  const found = [root];
  // The list grows while it is walked, so each new child is visited too.
  for (const parent of found) {
    for (const [pid, ppid] of table) {
      if (ppid === parent && pid !== undefined && !found.includes(pid)) {
        found.push(pid);
      }
    }
  }
  return found;
}

function child(phase: Phase, run: Run): ReturnType<typeof spawn> {
  const args = [...process.execArgv, import.meta.filename, phase, run.runtime, run.cwd, run.out];
  return spawn(process.execPath, args, { stdio: ["ignore", "inherit", "inherit"] });
}

function readJson(file: string): unknown {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  return value;
}

async function orchestrate(runtimeId: string, outFlag: string | undefined): Promise<void> {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const out = path.resolve(outFlag ?? path.join("oar-trial-run", `crash-resume-${runtimeId}-${stamp}`));
  const run: Run = { runtime: runtimeId, cwd: path.join(out, "cwd"), out };
  mkdirSync(run.cwd, { recursive: true });
  const first = child("phase1", run);
  await until(() => existsSync(path.join(out, "ready")) || first.exitCode !== null, 300_000, "phase one did not get ready");
  assert.ok(first.pid !== undefined && first.exitCode === null, "phase one exited early");
  const killed = descendants(first.pid);
  for (const pid of killed) {
    process.kill(pid, "SIGKILL");
  }
  const killedAt = Date.now();
  // Past the sleep's own end, so a surviving sleep would have written the marker.
  await delay(50_000);
  const markerWritten = existsSync(path.join(run.cwd, "crash-marker.txt"));
  const second = child("phase2", run);
  await once(second, "exit");
  const facts = { runtime: runtimeId, killedPids: killed.length, killedAt, markerWritten, phase1: readJson(path.join(out, "phase1.json")), phase2: readJson(path.join(out, "phase2.json")) };
  writeFileSync(path.join(out, "facts.json"), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify(facts, null, 2));
  console.log(`logs: ${out}`);
}

const [mode, runtimeArg, cwdArg, outArg] = process.argv.slice(2);
if (mode === "phase1" || mode === "phase2") {
  assert.ok(runtimeArg !== undefined && cwdArg !== undefined && outArg !== undefined);
  const run: Run = { runtime: runtimeArg, cwd: cwdArg, out: outArg };
  const phases = { phase1: phaseOne, phase2: phaseTwo };
  await phases[mode](run);
  process.exit(0);
}
assert.ok(mode !== undefined, "usage: crash-resume.ts <claude|codex|pi> [--out <dir>]");
const outIndex = process.argv.indexOf("--out");
await orchestrate(mode, outIndex === -1 ? undefined : process.argv[outIndex + 1]);
