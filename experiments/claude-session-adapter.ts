/**
 * LIVE RUN OF THE CLAUDE SESSION ADAPTER — the contract path, not raw stdio.
 *
 * Three scenarios against the real logged-in claude through
 * runtimes/claude/session.ts:
 *   1. steer: a three-tool turn steered mid-tool must fold the extra word into
 *      the same turn's final text (one turn_ended after the prompt request).
 *   2. abort: a long tool turn aborted mid-run must end aborted exactly once,
 *      the abort request answered by claude's control_response, and a late
 *      abort must be rejected.
 *   3. busy: prompting during an active turn is rejected busy.
 *
 * Run: pnpm tsx experiments/claude-session-adapter.ts   (requires logged-in `claude`)
 */
import { setTimeout as delay } from "node:timers/promises";
import { awaitTurnEnd, claudeRuntime, type SessionRecord } from "../packages/oar/src/index.js";

const installation = await claudeRuntime.installation();
if (installation.kind !== "available") {
  throw new Error("claude is not available on this machine");
}

const session = await claudeRuntime.session(installation, { cwd: process.cwd(), model: "haiku" });
const records: SessionRecord[] = [];
session.subscribe((record) => {
  records.push(record);
  const label = record.kind === "event"
    ? `${record.body.type}${record.body.views.length === 0 ? "" : ` → ${record.body.views.map((view) => view.kind).join(",")}`}`
    : `${record.kind} ${record.kind === "request" ? record.body.kind : record.body.kind}`;
  process.stdout.write(`${record.seq} ${record.agentPath.join("/") || "root"} ${label}\n`);
});

const textAfter = (seq: number): string => records
  .filter((record) => record.seq > seq && record.agentPath.length === 0 && record.kind === "event")
  .flatMap((record) => (record.kind === "event" ? record.body.views : []))
  .map((view) => (view.kind === "text_delta" ? view.text : ""))
  .join(" ");
const toolStartedAfter = (seq: number): boolean => records.some((record) =>
  record.seq > seq && record.kind === "event" && record.body.views.some((view) => view.kind === "tool_call_started"));

// 1. steer folds into the same turn
const first = await session.prompt([
  "Use the Bash tool twice, as two separate tool calls: first run",
  "`sleep 5; echo ALPHA`, then run `sleep 5; echo BRAVO`. Then reply with",
  "exactly the printed words in order plus any extra words I ask for later.",
].join(" "));
if (first.response.body.kind !== "accepted") {
  throw new Error("first prompt was not accepted");
}
const busy = await session.prompt("should be busy");
if (busy.response.body.kind !== "rejected") {
  throw new Error("busy invariant violated");
}
while (!toolStartedAfter(first.request.seq)) {
  // eslint-disable-next-line no-await-in-loop
  await delay(100);
}
const steer = await session.steer("Also append the word MANGO to your final reply.");
process.stdout.write(`steer -> ${steer.response.body.kind}\n`);
const firstOutcome = await awaitTurnEnd(session, first.request.seq);
const firstText = textAfter(first.request.seq);
if (firstOutcome.kind !== "completed" || !firstText.includes("MANGO") || !firstText.includes("BRAVO")) {
  throw new Error(`steer scenario failed: ${firstOutcome.kind} ${JSON.stringify(firstText)}`);
}
process.stdout.write("steer scenario OK: folded into the same turn\n");

// 2. abort ends the turn aborted exactly once
// claude's Bash tool blocks a long leading sleep, so loop short ones instead.
const second = await session.prompt(
  "Use the Bash tool to run exactly: for i in $(seq 1 40); do sleep 1; done; echo NEVER. Then reply done.",
);
if (second.response.body.kind !== "accepted") {
  throw new Error("second prompt was not accepted");
}
while (!toolStartedAfter(second.request.seq)) {
  // eslint-disable-next-line no-await-in-loop
  await delay(100);
}
await delay(2000);
const abort = await session.abort();
process.stdout.write(`abort -> ${abort.response.body.kind}\n`);
const secondOutcome = await awaitTurnEnd(session, second.request.seq);
if (secondOutcome.kind !== "aborted") {
  throw new Error(`expected aborted, got ${secondOutcome.kind}`);
}
const late = await session.abort();
if (late.response.body.kind !== "rejected") {
  throw new Error("late abort was not rejected");
}
process.stdout.write("abort scenario OK: aborted exactly once, late abort rejected\n");

await session.dispose();
process.stdout.write("claude session adapter live probe PASSED\n");
