/**
 * LIVE RUN OF THE CODEX SESSION ADAPTER: the contract path, not raw stdio.
 *
 * Three scenarios against the real logged-in codex through
 * runtimes/codex/session.ts:
 *   1. steer: a two-tool turn steered mid-tool must fold the extra word into
 *      the same turn's final text (one turn_ended after the prompt request).
 *   2. abort: a long tool turn aborted mid-run must end with codex's own
 *      interrupted status, and a late abort must be a rejected response.
 *   3. busy: prompting during an active turn is rejected busy.
 *
 * Run: pnpm tsx experiments/codex-session-adapter.ts   (requires logged-in `codex`)
 */
import { setTimeout as delay } from "node:timers/promises";
import { awaitTurnEnd, codexRuntime, type SessionRecord } from "../packages/oar/src/index.js";

const installation = await codexRuntime.installation();
if (installation.kind !== "available") {
  throw new Error("codex is not available on this machine");
}

const session = await codexRuntime.session(installation, { cwd: process.cwd() });
const records: SessionRecord[] = [];
session.subscribe((record) => {
  records.push(record);
  const label = record.kind === "event"
    ? `${record.body.type} ${record.body.views.map((view) => view.kind).join(",")}`
    : `${record.kind} ${record.body.kind}`;
  process.stdout.write(`${record.seq} ${record.spanId?.slice(0, 8) ?? "-"} ${label}\n`);
});

const textAfter = (seq: number): string => records
  .filter((record) => record.seq > seq && record.kind === "event")
  .flatMap((record) => (record.kind === "event" ? record.body.views : []))
  .map((view) => (view.kind === "text_delta" ? view.text : ""))
  .join("");
const toolStartedAfter = (seq: number): boolean => records.some((record) =>
  record.seq > seq && record.kind === "event" && record.body.views.some((view) => view.kind === "tool_call_started"));

// 1. steer folds into the same turn
const first = await session.prompt([
  "Run two shell commands, one at a time: first `sleep 5; echo ALPHA`, then",
  "`sleep 5; echo BRAVO`. Then reply with exactly the printed words in order",
  "plus any extra words I ask for later.",
].join(" "));
if (first.response.body.kind !== "accepted") {
  throw new Error("first prompt was not accepted");
}
const busy = await session.prompt("should be busy");
if (busy.response.body.kind !== "rejected") {
  throw new Error("busy invariant violated");
}
while (!toolStartedAfter(first.request.seq)) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- polling the stream
  await delay(100);
}
const steered = await session.steer("Also append the word MANGO to your final reply.");
process.stdout.write(`steer -> ${steered.response.body.kind}\n`);
const firstOutcome = await awaitTurnEnd(session, first.request.seq);
const firstText = textAfter(first.request.seq);
if (firstOutcome.kind !== "completed" || !firstText.includes("MANGO") || !firstText.includes("BRAVO")) {
  throw new Error(`steer scenario failed: ${firstOutcome.kind} ${JSON.stringify(firstText)}`);
}
process.stdout.write("steer scenario OK: folded into the same turn\n");

// 2. abort ends the turn with codex's own interrupted status
// mirror the claude probe: a loop of short sleeps keeps the tool running long enough
const second = await session.prompt(
  "Run this shell command: for i in $(seq 1 40); do sleep 1; done; echo NEVER. Then reply done.",
);
if (second.response.body.kind !== "accepted") {
  throw new Error("second prompt was not accepted");
}
while (!toolStartedAfter(second.request.seq)) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- polling the stream
  await delay(100);
}
await delay(2000);
const aborted = await session.abort();
if (aborted.response.body.kind !== "accepted") {
  throw new Error(`abort not accepted: ${JSON.stringify(aborted.response.body)}`);
}
const secondOutcome = await awaitTurnEnd(session, second.request.seq);
if (secondOutcome.kind !== "aborted") {
  throw new Error(`expected aborted, got ${secondOutcome.kind}`);
}
const late = await session.abort();
if (late.response.body.kind !== "rejected") {
  throw new Error("late abort must be a rejected response");
}
process.stdout.write("abort scenario OK: interrupted once, late abort rejected\n");

await session.dispose();
process.stdout.write("codex session adapter live probe PASSED\n");
