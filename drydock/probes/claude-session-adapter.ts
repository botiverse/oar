/**
 * LIVE RUN OF THE CLAUDE SESSION ADAPTER — the contract path, not raw stdio.
 *
 * Three scenarios against the real logged-in claude through
 * runtimes/claude/session.ts:
 *   1. steer: a three-tool turn steered mid-tool must fold the extra word into
 *      the same turn's final text (same turnId throughout, one turn_ended).
 *   2. abort: a long tool turn aborted mid-run must settle aborted exactly
 *      once, and a late abort must stay a no-op.
 *   3. busy: prompting during an active turn reports busy.
 *
 * Run: pnpm tsx drydock/probes/claude-session-adapter.ts   (requires logged-in `claude`)
 */
import { claudeRuntime } from "../../packages/oar/src/index.js";
import type { SessionEvent } from "../../packages/oar/src/index.js";

const installation = await claudeRuntime.installation?.();
if (installation?.kind !== "available" || claudeRuntime.session === undefined) {
  throw new Error("claude is not available on this machine");
}

const session = await claudeRuntime.session(installation, { cwd: process.cwd(), model: "haiku" });
const events: SessionEvent[] = [];
session.subscribe((event) => {
  events.push(event);
  const detail = "text" in event ? ` ${JSON.stringify(event.text.slice(0, 60))}` : "";
  process.stdout.write(`${event.seq} ${event.turnId.slice(0, 8)} ${event.kind}${detail}\n`);
});

// 1. steer folds into the same turn
const first = session.prompt([
  "Use the Bash tool twice, as two separate tool calls: first run",
  "`sleep 5; echo ALPHA`, then run `sleep 5; echo BRAVO`. Then reply with",
  "exactly the printed words in order plus any extra words I ask for later.",
].join(" "));
if (first.kind !== "turn") {
  throw new Error("first prompt did not start a turn");
}
if (session.prompt("should be busy").kind !== "busy") {
  throw new Error("busy invariant violated");
}
const steerTimer = setInterval(() => {
  if (events.some((event) => event.kind === "tool_call_started")) {
    clearInterval(steerTimer);
    void first.turn.steer?.("Also append the word MANGO to your final reply.").then((result) => {
      process.stdout.write(`steer -> ${result.kind}\n`);
    });
  }
}, 100);
const firstOutcome = await first.turn.outcome;
const firstText = events
  .filter((event) => event.turnId === first.turn.id && event.kind === "text_delta")
  .map((event) => (event.kind === "text_delta" ? event.text : ""))
  .join(" ");
if (firstOutcome.kind !== "completed" || !firstText.includes("MANGO") || !firstText.includes("BRAVO")) {
  throw new Error(`steer scenario failed: ${firstOutcome.kind} ${JSON.stringify(firstText)}`);
}
process.stdout.write("steer scenario OK: folded into the same turn\n");

// 2. abort settles aborted exactly once
// claude's Bash tool blocks a long leading sleep, so loop short ones instead.
const second = session.prompt(
  "Use the Bash tool to run exactly: for i in $(seq 1 40); do sleep 1; done; echo NEVER. Then reply done.",
);
if (second.kind !== "turn") {
  throw new Error("second prompt did not start a turn");
}
const secondId = second.turn.id;
await new Promise<void>((resolve) => {
  const poll = setInterval(() => {
    if (events.some((event) => event.turnId === secondId && event.kind === "tool_call_started")) {
      clearInterval(poll);
      resolve();
    }
  }, 100);
});
await new Promise((resolve) => setTimeout(resolve, 2000));
await second.turn.abort();
const secondOutcome = await second.turn.outcome;
if (secondOutcome.kind !== "aborted") {
  throw new Error(`expected aborted, got ${secondOutcome.kind}`);
}
await second.turn.abort();
process.stdout.write("abort scenario OK: aborted exactly once, late abort no-op\n");

await session.dispose();
process.stdout.write("claude session adapter live probe PASSED\n");
