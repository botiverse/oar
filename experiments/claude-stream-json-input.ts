/**
 * FIRST CONTACT WITH CLAUDE STREAM-JSON INPUT — can stdin be written at any
 * moment while the process lives, and what happens to a message written
 * mid-turn?
 *
 * Question under test (session-design thread, 2026-08-21): does claude's
 * `--input-format stream-json` have "cannot send right now" windows, and is a
 * mid-turn write injected into the active turn (steer-like), queued as the
 * next turn, rejected, or fatal?
 *
 * Method: three tiny prompts, each demanding a distinct exact reply so the
 * transcript shows which turn absorbed which input.
 *   A  written immediately after spawn        → "ok-1"
 *   B  written while A's turn is streaming    → "ok-2"   (the probe's point)
 *   C  written after the process goes idle    → "ok-3"
 * Every stdin write and every stdout message is timestamped into one timeline.
 *
 * Run: pnpm tsx experiments/claude-stream-json-input.ts   (requires logged-in `claude`)
 * Exits non-zero on any unmet expectation.
 *
 * ── OBSERVED 2026-08-21, claude 2.1.237 (haiku), linux x64 ──────────────────
 *
 * Two runs (fast turn A; long streaming turn A with B written ~850ms before
 * A's result). Identical verdict both times:
 *
 * 1. stdin accepted writes at every phase — at spawn, mid-turn while the
 *    assistant was streaming, and while idle. `stdin.write` returned true each
 *    time; no rejection, no error event, no process death.
 * 2. The mid-turn write was NOT injected into the active turn: turn A's result
 *    contained only A's demanded output.
 * 3. It was QUEUED AS THE NEXT TURN: a fresh system/init followed A's result
 *    within ~25ms and B's turn ran immediately with B's demanded output.
 *
 * ⚠️ CORRECTED by claude-stream-json-phases.ts: the "queue semantics" read
 * below is an artifact of a SINGLE-STEP turn (no tool calls → no remaining
 * model-step boundary inside the turn). With multi-tool turns the same write
 * is delivered INTO the active turn at the next step boundary — steer
 * semantics, same timing class as codex/pi. What stays true here: stdin is
 * writable at every phase, nothing is rejected or fatal, and each turn is
 * framed by its own system/init … result pair (clean Turn identity mapping).
 */
import { spawn } from "node:child_process";

const started = Date.now();
const t = (): string => `${String(Date.now() - started).padStart(6, " ")}ms`;
const log = (line: string): void => {
  process.stdout.write(`${t()}  ${line}\n`);
};

const child = spawn("claude", [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--model", "haiku",
], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });

let stderrText = "";
child.stderr.on("data", (chunk: Buffer | string) => {
  stderrText += chunk.toString();
});

const user = (text: string): string => `${JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
})}\n`;

const send = (label: string, text: string): void => {
  const accepted = child.stdin.write(user(text));
  log(`>> wrote ${label} (${text}) stdin.write returned ${accepted}`);
};

let results = 0;
let wroteB = false;
let wroteC = false;
const resultTexts: string[] = [];
let buffer = "";

const finish = (code: number, verdict: string): void => {
  log(`VERDICT: ${verdict}`);
  if (code !== 0) {
    process.stdout.write(`stderr tail: ${stderrText.slice(-500)}\n`);
  }
  child.kill("SIGTERM");
  process.exit(code);
};

setTimeout(() => {
  finish(1, `timeout: ${results} results seen; stderr tail: ${stderrText.slice(-300)}`);
}, 180_000);

child.on("exit", (code) => {
  log(`child exited code=${code} after ${results} results`);
  if (results < 3) {
    finish(1, `process died before all turns settled (exit ${code})`);
  }
});

function parseRecord(line: string): Record<string, unknown> | null {
  const value = ((): unknown => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })();
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function settle(): void {
  const [a, b, c] = resultTexts;
  const clean = a !== undefined && a.includes("ok-1") && !a.includes("ok-2")
    && b !== undefined && b.includes("ok-2")
    && c !== undefined && c.includes("ok-3");
  finish(
    clean ? 0 : 1,
    clean
      ? "mid-turn write ACCEPTED and QUEUED AS NEXT TURN (not injected into the active turn, not rejected, not fatal)"
      : `unexpected attribution: ${JSON.stringify(resultTexts)}`,
  );
}

function record(message: Record<string, unknown>, kind: string): void {
  if (kind === "result") {
    results += 1;
    const text = typeof message.result === "string" ? message.result.trim() : "";
    resultTexts.push(text);
    log(`<< result #${results}: ${JSON.stringify(text.slice(0, 80))}`);
  } else {
    const subtype = typeof message.subtype === "string" ? `/${message.subtype}` : "";
    log(`<< ${kind}${subtype}`);
  }
}

// Drive the experiment forward from what the transcript shows.
function drive(kind: string): void {
  if (!wroteB && (kind === "assistant" || kind === "stream_event")) {
    wroteB = true;
    send("B mid-turn", "Reply with exactly ok-2 and nothing else.");
  }
  if (results === 2 && !wroteC) {
    wroteC = true;
    send("C while idle", "Reply with exactly ok-3 and nothing else.");
  }
  if (results === 3) {
    settle();
  }
}

function handleMessage(message: Record<string, unknown>): void {
  const kind = typeof message.type === "string" ? message.type : "unknown";
  record(message, kind);
  drive(kind);
}

function handleLine(line: string): void {
  const message = parseRecord(line);
  if (message === null) {
    log(`<< unparseable line: ${line.slice(0, 120)}`);
  } else {
    handleMessage(message);
  }
}

child.stdout.on("data", (chunk: Buffer | string) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length > 0) {
      handleLine(line);
    }
  }
});

send("A at spawn", "Reply with exactly ok-1 and nothing else.");
