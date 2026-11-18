import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { acpSession } from "../packages/oar/src/shared/acp/session.js";
import { promptAndWait } from "../packages/oar/src/observe/turns.js";
import type { Frame } from "../packages/oar/src/contracts/records.js";
import { asRecord, asRecordList, parseJson } from "../packages/oar/src/shared/json.js";
import { retainTurnFailure } from "../sea-trial/harness/turn-failure.js";

// oxlint-disable-next-line eslint/max-statements -- One native refusal checked through the saved outcome and redacted artifact.
test("failed ACP turns retain their reason and redacted native error without an open shared trace", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-turn-failure-"));
  const secret = "turn-failure-synthetic-secret";
  const open = acpSession({ args: [fileURLToPath(new URL("fixtures/fake-acp-open-error.mjs", import.meta.url))], capabilities: { queue: { durable: false }, attribution: "nested" } });
  const session = await open({ kind: "available", via: "executable", command: process.execPath }, {
    cwd: directory, env: { TEST_API_KEY: secret, FAKE_ERROR_METHOD: "session/prompt",
      FAKE_ERROR: JSON.stringify({ code: -32_000, message: `provider refused ${secret}`, data: { status: 401 } }) },
  });
  try {
    const outcome = await promptAndWait(session, "fail", { timeoutMs: 5000 });
    expect(outcome).toMatchObject({ kind: "ended", outcome: { kind: "failed" } });
    const file = await retainTurnFailure(session, outcome, { phase: "creation" }, directory);
    const contents = await readFile(file, "utf8");
    expect(contents).toContain("provider refused [redacted]");
    expect(contents).not.toContain(secret);
    const artifact = asRecord(parseJson(contents));
    expect(artifact?.outcome).toEqual(outcome);
    expect(asRecordList(artifact?.frames).some(frame => typeof frame.json === "string" && frame.json.includes('"code":-32000'))).toBe(true);
  } finally { await session.dispose(); await rm(directory, { recursive: true, force: true }); }
});

// oxlint-disable-next-line eslint/max-statements -- Check the count, size and newest error in one saved artifact.
test("failure artifacts bound the native tail and preserve the newest error", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-turn-tail-"));
  const frames: Frame[] = Array.from({ length: 20 }, (_, seq) => ({
    sessionId: "fixture", agentPath: [], seq, receivedAt: seq, kind: "frame",
    body: { type: "native", native: { padding: "x".repeat(20_000), error: `last-error-${seq}` }, events: [] },
  }));
  try {
    const outcome = { kind: "failed", reason: "native failure" };
    const file = await retainTurnFailure({ id: "fixture", records: () => frames }, outcome, {}, directory);
    const contents = await readFile(file, "utf8");
    const saved = asRecordList(asRecord(parseJson(contents))?.frames);
    expect(saved.map(frame => frame.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 8));
    expect(saved.every(frame => frame.truncated === true && typeof frame.json === "string" && frame.json.length <= 16_384)).toBe(true);
    expect(saved.at(-1)?.json).toContain("last-error-19");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
