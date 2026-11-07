import assert from "node:assert/strict";
import { test } from "vitest";
import { snapshotFixtureProcesses } from "../sea-trial/harness/fixture-process-snapshot.js";

test.skipIf(process.platform !== "win32")("the native cleanup observer captures its test worker", async () => {
  const snapshot = await snapshotFixtureProcesses();
  assert.equal(snapshot.outcome, "captured", JSON.stringify(snapshot));
  assert.ok(snapshot.processes.some(row => row.pid === process.pid),
    `Test worker ${process.pid} missing from process snapshot: ${JSON.stringify(snapshot)}`);
});
