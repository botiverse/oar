import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { grokInstallation, grokSession, promptAndWait, awaitTurnEnd, type Session } from "../../packages/oar/src/index.js";
import { startGrokAimock } from "../harness/aimock-acp.js";

const outputSchema = { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false };

test.skipIf(process.env.OAR_TEST !== "grok-aimock")("Grok returns its validated native value on new/resume, steer and queue", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oar-grok-schema-"));
  const provider = await startGrokAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: '{"answer":4}' }, { latency: 150 }); });
  let session: Session | undefined = undefined;
  try {
    const installation = await grokInstallation();
    if (installation.kind !== "available") { throw new Error("Grok unavailable"); }
    session = await grokSession(installation, { cwd: root, env: provider.env, outputSchema });
    const first = await session.prompt("Answer");
    expect(await session.steer?.("Answer with 4")).toMatchObject({ kind: "accepted" });
    expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "completed", structuredOutput: { answer: 4 } });
    const queued = await session.queue("Answer from the queue");
    expect(queued.kind).toBe("accepted");
    expect(await awaitTurnEnd(session, queued.seq)).toEqual({ kind: "completed", structuredOutput: { answer: 4 } });
    const id = session.id;
    await session.dispose();
    session = await grokSession(installation, { cwd: root, env: provider.env, outputSchema, resume: id });
    expect(await promptAndWait(session, "Answer after resuming", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed", structuredOutput: { answer: 4 } } });
  } finally { await session?.dispose(); await provider.stop(); await rm(root, { recursive: true, force: true }); }
}, 120_000);

test.skipIf(process.env.OAR_TEST !== "grok-aimock").each(["invalid-value", "invalid-schema"])("Grok's %s is failed despite native end_turn", async (mode) => {
  const root = await mkdtemp(path.join(tmpdir(), "oar-grok-schema-"));
  const provider = await startGrokAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: '{"answer":"wrong"}' }); });
  let session: Session | undefined = undefined;
  try {
    const installation = await grokInstallation();
    if (installation.kind !== "available") { throw new Error("Grok unavailable"); }
    session = await grokSession(installation, { cwd: root, env: provider.env, outputSchema: mode === "invalid-schema" ? { type: "not-a-type" } : outputSchema });
    const run = await promptAndWait(session, "Answer", { timeoutMs: 30_000 });
    expect(run).toMatchObject({ kind: "ended", outcome: { kind: "failed", failure: "unknown" } });
    if (run.kind !== "rejected") { expect(run.outcome).not.toHaveProperty("structuredOutput"); }
    expect(JSON.stringify(session.records())).toContain("structuredOutputError");
  } finally { await session?.dispose(); await provider.stop(); await rm(root, { recursive: true, force: true }); }
}, 120_000);
