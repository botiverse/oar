/**
 * LIVE QUEUE — session.queue during an active turn runs as the NEXT turn
 * (codex: native thread/queue; claude: adapter-held, drained at turn end),
 * surfaced as a spontaneous turn: records with no prompt request of their
 * own, ended by the runtime's own turn_ended.
 *
 * Run: pnpm tsx experiments/session-queue.ts <claude|codex>
 */
import { setTimeout as delay } from "node:timers/promises";
import { awaitTurnEnd, runtimes, type SessionRecord } from "../packages/oar/src/index.js";

const runtime = runtimes.require(process.argv[2] ?? "claude");
const model = runtime.id === "claude" ? { model: "haiku" } : {};
const probed = await runtime.installation?.();
if (probed?.kind !== "available") {
  throw new Error(`${runtime.id} is not available`);
}
const session = await runtime.session(probed, { cwd: process.cwd(), ...model });
const records: SessionRecord[] = [];
session.subscribe((record) => {
  records.push(record);
  const detail = record.kind === "event" ? record.body.views.map((view) => (view.kind === "text_delta" ? ` ${JSON.stringify(view.text.slice(0, 40))}` : ` ${view.kind}`)).join("") : "";
  process.stdout.write(`${record.seq} ${record.kind} ${record.kind === "event" ? record.body.type : record.body.kind}${detail}\n`);
});

const first = await session.prompt(
  runtime.id === "claude"
    ? "Use the Bash tool to run exactly: for i in $(seq 1 8); do sleep 1; done; echo SLOW-DONE. Then reply done."
    : "Run this shell command: for i in $(seq 1 8); do sleep 1; done; echo SLOW-DONE. Then reply done.",
);
if (first.response.body.kind !== "accepted") {
  throw new Error("busy");
}
while (!records.some((record) => record.kind === "event" && record.body.views.some((view) => view.kind === "tool_call_started"))) {
  // eslint-disable-next-line no-await-in-loop
  await delay(100);
}
if (session.capabilities.queue === null) {
  throw new Error(`${runtime.id} has no queue capability`);
}
const queued = await session.queue("Reply with exactly ok-q and nothing else.");
process.stdout.write(`queued during active turn (durable=${String(session.capabilities.queue.durable)}) -> ${queued.response.body.kind}\n`);
const firstEnd = await awaitTurnEnd(session, first.request.seq);
const firstEndSeq = records.findLast((record) => record.kind === "event" && record.body.views.some((view) => view.kind === "turn_ended"))?.seq ?? first.request.seq;
process.stdout.write(`first turn ${firstEnd.kind}\n`);

// The queued input must run as a spontaneous next turn.
const deadline = Date.now() + 60_000;
const answered = (): boolean => records
  .filter((record) => record.seq > firstEndSeq && record.kind === "event")
  .flatMap((record) => (record.kind === "event" ? record.body.views : []))
  .map((view) => (view.kind === "text_delta" ? view.text : ""))
  .join("")
  .includes("ok-q");
while (!answered() && Date.now() < deadline) {
  // eslint-disable-next-line no-await-in-loop
  await delay(250);
}
await session.dispose();
if (!answered()) {
  throw new Error("queued input never ran as a next turn");
}
process.stdout.write(`${runtime.id} queue probe PASSED\n`);
