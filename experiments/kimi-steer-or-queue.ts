/**
 * KIMI steerOrQueue — the fallback path on a runtime that declares
 * `capabilities.steer: false`.
 *
 * Why: `kimi acp` has no steer method (kimi-code acp-server exposes
 * `session/prompt` and `session/cancel` only), so the profile declares
 * `steer: false` and `steer()` is always `rejected not_steerable`. The sealed
 * session's `steerOrQueue()` must then land the input as `queued`, and the
 * queued input must run as a SPONTANEOUS turn once the active one closes:
 * its own `session/prompt` answer with a `turn_ended` view, but no prompt
 * request record of its own (the queue request is the caller's record).
 *
 * Run: pnpm tsx experiments/kimi-steer-or-queue.ts [--out <dir>]
 * Burns tokens for two short kimi turns; writes an oar-voyage/2 log.
 *
 * ── OBSERVED 2026-09-11, kimi 0.42.0, darwin arm64 ──
 * See docs/runtimes/kimi.md ("Prompting, steering, queuing, and cancellation"
 * evidence) for the record seqs of the run this script produced.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { awaitTurnEnd, kimiRuntime, openVoyage, type RequestRecord } from "../packages/oar/src/index.js";

const outIndex = process.argv.indexOf("--out");
const outFlag = outIndex === -1 ? undefined : process.argv[outIndex + 1];
assert.ok(outIndex === -1 || (outFlag !== undefined && !outFlag.startsWith("--")), "--out needs a directory");
const outDir = outFlag ?? path.join(process.cwd(), "oar-trial-run", `kimi-steer-or-queue-${new Date().toISOString().replaceAll(":", "-")}`);
mkdirSync(outDir, { recursive: true });

const installation = await kimiRuntime.installation();
assert.ok(installation.kind === "available", "kimi is not available on this machine");
const session = await kimiRuntime.session(installation, { cwd: process.cwd() });
const voyagePath = path.join(outDir, "steer-or-queue.voyage.jsonl");
const log = openVoyage(voyagePath, {
  runtime: "kimi",
  cwd: process.cwd(),
  sessionId: session.id,
  startedAt: Date.now(),
  recorder: "experiments/kimi-steer-or-queue.ts",
});
session.subscribe((record) => {
  log.record(record);
}, { sessionId: session.id, afterSeq: -1 });

const first = await session.prompt("Use your shell tool to run exactly: sleep 5; echo FIRST. Then reply with exactly FIRST-DONE.");
assert.equal(first.response.body.kind, "accepted");
// Wait for the tool call so the turn is unmistakably active.
const deadline = Date.now() + 120_000;
while (!session.records().some((record) => record.seq > first.request.seq && record.kind === "event" && record.body.views.some((view) => view.kind === "tool_call_started"))) {
  assert.ok(Date.now() < deadline, "no tool call started within 120 s");
  // eslint-disable-next-line no-await-in-loop
  await delay(100);
}
const landed = await session.steerOrQueue("Reply with exactly QUEUED-OK and nothing else.");
const steerRecord = session.records().find((record): record is RequestRecord => record.kind === "request" && record.body.kind === "steer");
const steerAnswer = session.records().find((record) => record.kind === "response" && steerRecord !== undefined && record.requestId === steerRecord.id);
const firstOutcome = await awaitTurnEnd(session, first.request.seq);
const firstEnd = session.records().find((record) => record.seq > first.request.seq && record.kind === "event" && record.body.views.some((view) => view.kind === "turn_ended"));
assert.ok(firstEnd !== undefined);
const secondOutcome = await awaitTurnEnd(session, firstEnd.seq);
const secondEnd = session.records().find((record) => record.seq > firstEnd.seq && record.kind === "event" && record.body.views.some((view) => view.kind === "turn_ended"));
const between = session.records().filter((record) => record.seq > firstEnd.seq && record.seq < (secondEnd?.seq ?? Number.POSITIVE_INFINITY));
const secondText = between.flatMap((record) => (record.kind === "event" ? record.body.views.flatMap((view) => (view.kind === "text_delta" ? [view.text] : [])) : [])).join("");
await session.dispose();
log.end("done");

const report = {
  version: installation.via === "executable" ? (installation.version ?? null) : null,
  capabilities: session.capabilities,
  landed: landed.landed,
  steerAnswer: steerAnswer?.kind === "response" ? { seq: steerAnswer.seq, body: steerAnswer.body } : null,
  queueRequestSeq: landed.result.request.seq,
  queueAnswer: landed.result.response.body,
  firstOutcome,
  firstEndSeq: firstEnd.seq,
  secondOutcome,
  secondEndSeq: secondEnd?.seq ?? null,
  promptRequestsBetween: between.filter((record) => record.kind === "request" && record.body.kind === "prompt").length,
  secondText,
  voyage: voyagePath,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
assert.equal(landed.landed, "queued", "steerOrQueue must fall back to the host queue on kimi");
assert.equal(report.promptRequestsBetween, 0, "the drained input runs as a spontaneous turn: no prompt request of its own");
assert.ok(secondText.includes("QUEUED-OK"), `queued input did not run as the next turn: ${JSON.stringify(secondText)}`);
