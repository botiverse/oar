/**
 * CODEX RESUME USAGE: what a real codex reports about token totals when a
 * thread is resumed in a new app-server process, and what the adapter's
 * `usage()` makes of it (#169). Scripted provider (codex-aimock): no login,
 * no tokens.
 *
 * Method: session A prompts "first" (the provider bills 1000 in / 5 out) and
 * is disposed; session B resumes A's thread and prompts "second" (1200 in /
 * 7 out). For session B the probe prints every root
 * `thread/tokenUsage/updated` frame: where it arrived (before or inside B's
 * first turn), whose turn id it carries, codex's own `total` and the
 * `tokens` oar read from it; then both sessions' `usage()` and B's record
 * order. `rereport` classifies how codex re-reported A's total, if at all.
 *
 * Run: pnpm tsx experiments/codex-resume-usage.ts
 *      OAR_CODEX_BIN=<another codex> pnpm tsx experiments/codex-resume-usage.ts
 * (an old release: `npm install --prefix <dir> @openai/codex@<version>`, then
 * `<dir>/node_modules/.bin/codex`).
 *
 * ── OBSERVED 2026-10-07, Linux x64, one run per version ──
 * - 0.151.0, 0.153.0, 0.154.0, 0.155.1, 0.160.1: `before-first-turn`. Right
 *   after the `thread/resume` reply, codex sends one
 *   `thread/tokenUsage/updated { threadId, turnId: <A's turn>, tokenUsage:
 *   { total, last, modelContextWindow } }` whose total is A's 1000 / 5. It
 *   races the prompt request (recorded before it on 0.153.0 / 0.154.0,
 *   after it on 0.151.0 / 0.155.1 / 0.160.1), always ahead of the prompt's
 *   reply and B's `turn/started`. After B's turn the total is 2200 / 12;
 *   with the baseline B's `usage()` is 1200 / 7.
 * - 0.131.0 to 0.150.1 (0.131-0.137, 0.141, 0.144.6, 0.149.0, 0.149.1,
 *   0.150.0, 0.150.1 run): `none`. B's only report is the thread's
 *   2200 / 12.
 * - 0.118.0, 0.130.0: `inside-first-turn`. After B's `turn/started` and its
 *   userMessage item, before the model call, codex reports A's 1000 / 5
 *   under B's own turn id, then 2200 / 12.
 * Without a re-report before the first turn the adapter cannot tell B's
 * share, so on these releases B's usage events carry `context` only and
 * `usage().total` is null (rechecked on 0.118.0, 0.130.0 and 0.149.0 after
 * that rule, and 1200 / 7 on 0.151.0 and 0.160.1).
 */
import { codexInstallation, codexSession, promptAndWait } from "../packages/oar/src/index.js";
import type { Frame, RawEvent, Session, TokenTotals } from "../packages/oar/src/contracts/session.js";
import { asNumber, asRecord } from "../packages/oar/src/shared/json.js";
import { startCodexAimock } from "../sea-trial/harness/aimock.js";

const env = await startCodexAimock((mock) => {
  mock.onMessage(/first/u, { content: "pong", usage: { input_tokens: 1000, output_tokens: 5 } });
  mock.onMessage(/second/u, { content: "pong", usage: { input_tokens: 1200, output_tokens: 7 } });
});

interface UsageFrame {
  readonly seq: number;
  readonly arrived: "before-first-turn" | "inside-first-turn" | "later";
  readonly turn: "previous" | "this-session" | "none";
  readonly codexTotal: { readonly input: number | null; readonly output: number | null };
  readonly tokens: TokenTotals | undefined;
}

function turnIds(records: readonly RawEvent[]): string[] {
  return records.flatMap((record) => (record.kind === "frame" && record.body.type === "turn/started" && record.spanId !== undefined ? [record.spanId] : []));
}

/** One root `thread/tokenUsage/updated`, read with how many root turns had started before it. */
function usageFrame(record: Frame, turnsStarted: number, previousTurns: readonly string[]): UsageFrame {
  const native = asRecord(record.body.native);
  const total = asRecord(asRecord(native?.tokenUsage)?.total);
  const usage = record.body.events.find((event) => event.kind === "usage");
  let turn: UsageFrame["turn"] = "none";
  if (typeof native?.turnId === "string") {
    turn = previousTurns.includes(native.turnId) ? "previous" : "this-session";
  }
  let arrived: UsageFrame["arrived"] = "later";
  if (turnsStarted === 0) {
    arrived = "before-first-turn";
  } else if (turnsStarted === 1) {
    arrived = "inside-first-turn";
  }
  return {
    seq: record.seq,
    arrived,
    turn,
    codexTotal: { input: asNumber(total?.inputTokens), output: asNumber(total?.outputTokens) },
    tokens: usage?.kind === "usage" ? usage.usage.tokens : undefined,
  };
}

function usageFrames(records: readonly RawEvent[], root: string, previousTurns: readonly string[]): UsageFrame[] {
  let turnsStarted = 0;
  const frames: UsageFrame[] = [];
  for (const record of records) {
    if (record.kind === "frame" && record.sessionId === root) {
      if (record.body.type === "turn/started") { turnsStarted += 1; }
      if (record.body.type === "thread/tokenUsage/updated") { frames.push(usageFrame(record, turnsStarted, previousTurns)); }
    }
  }
  return frames;
}

/** How codex re-reported the earlier session's total `before` in the resumed session's frames. */
function rereport(frames: readonly UsageFrame[], before: TokenTotals | null): string {
  const same = (frame: UsageFrame): boolean => frame.codexTotal.input === before?.input && frame.codexTotal.output === before.output;
  const first = frames.find((frame) => same(frame));
  return first === undefined ? "none" : first.arrived;
}

function order(records: readonly RawEvent[]): string[] {
  return records.map((record) => {
    if (record.kind === "frame") {
      return `${record.seq} ${record.body.type}${record.spanId === undefined ? "" : ` @${record.spanId}`}`;
    }
    return `${record.seq} ${record.kind} ${record.body.kind}`;
  });
}

async function run(session: Session, prompt: string): Promise<Session> {
  const result = await promptAndWait(session, prompt);
  if (result.kind !== "ended" || result.outcome.kind !== "completed") {
    throw new Error(`turn did not complete: ${JSON.stringify(result)}`);
  }
  await session.dispose();
  return session;
}

try {
  const installation = await codexInstallation();
  if (installation.kind !== "available" || installation.via !== "executable") {
    throw new Error(`codex is not available as an executable: ${installation.kind}`);
  }
  const options = { cwd: process.cwd(), model: "gpt-5.1", ...(env.env === undefined ? {} : { env: env.env }) };
  const opened = await run(await codexSession(installation, options), "first");
  const resumed = await run(await codexSession(installation, { ...options, resume: opened.id }), "second");
  const frames = usageFrames(resumed.records(), resumed.id, turnIds(opened.records()));
  const usage = { opened: opened.usage().value, resumed: resumed.usage().value };
  const report = {
    version: installation.version,
    rereport: rereport(frames, usage.opened.total),
    resumedUsageFrames: frames,
    usage,
    resumedOrder: order(resumed.records()),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await env.stop();
}
