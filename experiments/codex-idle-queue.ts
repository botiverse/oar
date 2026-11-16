/** Native idle queue admission, with a loopback aimock provider and no account. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { codexFixture } from "./sharing/codex-fixture.js";
import { asRecord, type JsonRecord } from "../packages/oar/src/shared/json.js";

const directory = path.resolve(process.argv[2] ?? "oar-trial-run/codex-idle-queue");
await mkdir(directory, { recursive: true });
const fixture = await codexFixture();
const report: JsonRecord = { at: new Date().toISOString(), installation: fixture.installation, observations: [] };
const observations: JsonRecord[] = [];
report.observations = observations;
try {
  const client = await fixture.connect();
  const threadId = await fixture.open(client, "A", { withMcp: false });
  await fixture.turn(client, threadId, "A_initial");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = fixture.events.length;
    const startedAt = performance.now();
    const inputId = `idle-queue-${attempt}`;
    // oxlint-disable-next-line no-await-in-loop -- Each sample starts after the preceding native turn completes.
    const added = await fixture.request(client, "thread/queue/add", { threadId,
      input: [{ type: "text", text: `OAR_SHARE_A_idle${attempt}` }], clientUserMessageId: inputId });
    const row: JsonRecord = { inputId, added, replyMs: performance.now() - startedAt };
    observations.push(row);
    const started = (): JsonRecord | null => asRecord(fixture.events.slice(before).find((event) =>
      event.method === "turn/started" && event.params.threadId === threadId)?.params.turn);
    const deadline = performance.now() + 10_000;
    while (started() === null && performance.now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop -- Bounded native observation; record the polling resolution.
      await delay(20);
    }
    row.observationMs = performance.now() - startedAt;
    row.pollMs = 20;
    row.turnStartedWithoutPrompt = started();
    // oxlint-disable-next-line no-await-in-loop -- Read the queue after the observed start or bounded idle wait.
    row.queueAfterObservation = await fixture.request(client, "thread/queue/list", { threadId });
    const turnId = started()?.id;
    if (typeof turnId === "string") {
      // oxlint-disable-next-line no-await-in-loop -- Do not enqueue the next sample before this one is idle.
      await fixture.timing.until(() => fixture.ended(threadId, turnId) !== null, `${inputId} completed`);
      row.completed = fixture.ended(threadId, turnId);
    } else {
      // oxlint-disable-next-line no-await-in-loop -- If admission does not wake, observe ordering against the next explicit prompt.
      row.explicitNext = await fixture.turn(client, threadId, "A_next");
      // oxlint-disable-next-line no-await-in-loop -- Give the native dispatcher a bounded opportunity after that prompt.
      await delay(1000);
      break;
    }
  }
  await fixture.turn(client, threadId, "A_final");
  const held = await fixture.start(client, threadId, "A_hold");
  await fixture.timing.until(() => fixture.gates.has("A_hold"), "provider holding turn");
  await fixture.request(client, "turn/interrupt", { threadId, turnId: held });
  await fixture.timing.until(() => fixture.ended(threadId, held) !== null, "interrupted turn completed");
  fixture.gates.get("A_hold")?.resolve();
  const beforeInterrupted = fixture.events.length;
  const interruptedAt = performance.now();
  const afterInterrupted: JsonRecord = { precedingTurn: fixture.ended(threadId, held) };
  report.afterInterrupted = afterInterrupted;
  afterInterrupted.added = await fixture.request(client, "thread/queue/add", { threadId,
    input: [{ type: "text", text: "OAR_SHARE_A_afterinterrupt" }], clientUserMessageId: "after-interrupt" });
  await delay(10_000);
  afterInterrupted.observationMs = performance.now() - interruptedAt;
  afterInterrupted.startedBeforeNextPrompt = fixture.events.slice(beforeInterrupted).filter((event) => event.method === "turn/started");
  afterInterrupted.queueBeforeNextPrompt = await fixture.request(client, "thread/queue/list", { threadId });
  afterInterrupted.nextPrompt = await fixture.turn(client, threadId, "A_wake");
  await fixture.timing.until(() => fixture.events.slice(beforeInterrupted).filter((event) => event.method === "turn/completed").length === 2, "explicit prompt then queued turn complete");
  afterInterrupted.turns = fixture.events.slice(beforeInterrupted).filter((event) => event.method === "turn/completed");
  report.finalQueue = await fixture.request(client, "thread/queue/list", { threadId });
  assert.equal(asRecord(report.finalQueue)?.nextCursor, null);
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  Object.assign(report, { calls: fixture.calls, events: fixture.events, seen: fixture.seen, raw: fixture.provider.raw, waits: fixture.timing.waits });
  await writeFile(path.join(directory, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ observations, afterInterrupted: report.afterInterrupted, finalQueue: report.finalQueue, error: report.error }, null, 2));
  await fixture.stop();
}
