import guardedFixtureArgs from "../fixtures/guard-processes.js";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { gone, type ProcessIdentity, reportedProcess, signalFixture } from "../fixtures/process-tree.js";
import { captureCleanupEvidence, expectCleanupEvidence, expectOrphanReclaimed } from "../fixtures/cleanup-evidence.js";

afterEach(() => { vi.restoreAllMocks(); });

// Cancellation can orphan tools outside the process group on every platform.
// oxlint-disable-next-line eslint/max-statements -- Drive the public isolated session through a cancel that orphans a real tool.
test("ACP disposal captures tools before native cancellation severs their parent chain", async () => {
  const cleanupEvidence = captureCleanupEvidence();
  const fixture = fileURLToPath(new URL("../fixtures/shutdown-orphan-tree.mjs", import.meta.url));
  const session = await acpSession({ args: guardedFixtureArgs(fixture, "acp"), capabilities: { queue: { durable: false }, attribution: "opaque" } })(
    { kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd() },
  );
  let owned: { middle: ProcessIdentity; tool: ProcessIdentity } | undefined = undefined;
  try {
    await session.prompt("start");
    await expect.poll(() => session.records().flatMap(r => r.kind === "frame" ? r.body.events.filter(e => e.kind === "text_delta").map(e => e.text) : []).join(""), { timeout: 10_000 }).not.toBe("");
    const text = session.records().flatMap(r => r.kind === "frame" ? r.body.events.filter(e => e.kind === "text_delta").map(e => e.text) : []).join("");
    const value = asRecord(JSON.parse(text));

    owned = { middle: reportedProcess(value?.middle), tool: reportedProcess(value?.tool) };
    expect(await gone(owned.middle, 50)).toBe(false); expect(await gone(owned.tool, 50)).toBe(false);
    await session.dispose();
    expect(await gone(owned.middle)).toBe(true);
    const exits = session.records().filter(r => r.kind === "response" && r.body.kind === "exited");
    expect(exits).toHaveLength(1);
    const [exit] = exits;
    const evidence = cleanupEvidence();
    expectCleanupEvidence(evidence, exit?.kind === "response" && exit.body.kind === "exited" ? exit.body.reason : undefined);
    const capture = evidence.observations.findLast(entry => entry.phase === "before_eof");
    expect(capture).toBeDefined();
    await expectOrphanReclaimed(owned.tool, evidence, capture);
  } finally {
    await session.dispose();
    for (const pid of owned === undefined ? [] : [owned.middle, owned.tool]) { signalFixture(pid); }
  }
});
