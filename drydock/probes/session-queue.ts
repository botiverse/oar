/**
 * LIVE QUEUE — session.queue.add during an active turn runs as the NEXT turn
 * (codex: native thread/queue; claude: adapter-held, drained at turn end),
 * surfaced as a spontaneous kernel turn with attributable events.
 *
 * Run: pnpm tsx drydock/probes/session-queue.ts <claude|codex>
 */
import { setTimeout as delay } from "node:timers/promises";
import { runtimes, type SessionEvent } from "../../packages/oar/src/index.js";

const runtime = runtimes.require(process.argv[2] ?? "claude");
const model = runtime.id === "claude" ? { model: "haiku" } : {};
const probed = await runtime.installation?.();
if (probed?.kind !== "available") {
  throw new Error(`${runtime.id} is not available`);
}
const session = await runtime.session(probed, { cwd: process.cwd(), ...model });
const events: SessionEvent[] = [];
session.subscribe((event) => {
  events.push(event);
  const detail = "text" in event ? ` ${JSON.stringify(event.text.slice(0, 40))}` : "";
  process.stdout.write(`${event.seq} ${event.turnId.slice(0, 8)} ${event.kind}${detail}\n`);
});

const first = session.prompt(
  runtime.id === "claude"
    ? "Use the Bash tool to run exactly: for i in $(seq 1 8); do sleep 1; done; echo SLOW-DONE. Then reply done."
    : "Run this shell command: for i in $(seq 1 8); do sleep 1; done; echo SLOW-DONE. Then reply done.",
);
if (first.kind !== "turn") {
  throw new Error("busy");
}
while (!events.some((event) => event.kind === "tool_call_started")) {
  // eslint-disable-next-line no-await-in-loop
  await delay(100);
}
if (session.queue === undefined) {
  throw new Error(`${runtime.id} has no queue capability`);
}
await session.queue.add("Reply with exactly ok-q and nothing else.");
process.stdout.write(`queued during active turn (durable=${session.queue.durable})\n`);
await first.turn.outcome;

// The queued input must run as a spontaneous next turn.
const deadline = Date.now() + 60_000;
const answered = (): boolean => events
  .filter((event) => event.turnId !== first.turn.id && event.kind === "text_delta")
  .map((event) => (event.kind === "text_delta" ? event.text : ""))
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
