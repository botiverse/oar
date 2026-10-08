import assert from "node:assert/strict";
import { test } from "vitest";
import { interruptedInputProbe } from "./support/input-interruption.js";

test.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex discards an accepted unread steer on interruption before reporting turn end", async () => {
  const report = await interruptedInputProbe("codex");
  assert.deepEqual(report.answers.map((answer) => answer.kind), ["accepted", "accepted"]);
  assert.deepEqual(report.outcome, { kind: "aborted" });
  assert.deepEqual(report.nextOutcome, { kind: "completed" });
  assert.equal(report.input?.state, "dropped");
  assert.equal(report.input.reason, "turn_interrupted");
  assert.equal(report.input.observations.length, 0);
  assert.deepEqual(report.pending, []);
  assert.ok(report.provider.some((request) => request.afterNextPrompt));
  assert.ok(report.provider.every((request) => !request.hasMarker), JSON.stringify(report.provider));
  const interrupted = report.records.find((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "input_dropped"));
  assert.equal(interrupted?.kind, "frame");
  assert.equal(interrupted.body.type, "turn/completed");
  assert.deepEqual(interrupted.body.events.map((event) => event.kind), ["input_dropped", "turn_ended"]);
}, 60_000);
