import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { defineRuntime, piInstallation, piSession, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { startPiAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";

test.skipIf(process.env.OAR_TEST !== "pi-aimock")("a Pi extension's native abort is reported without an OAR abort request", async () => {
  const env = await startPiAimock((mock) => {
    mock.onMessage(/[\s\S]*/u, { toolCalls: [{ name: "bash", arguments: JSON.stringify({ command: "echo unreachable" }) }] });
  });
  let session: Session | undefined = undefined;
  try {
    const agentDir = process.env.OAR_PI_AGENT_DIR;
    assert.ok(agentDir !== undefined);
    const extensions = path.join(agentDir, "extensions");
    await mkdir(extensions, { recursive: true });
    await writeFile(path.join(extensions, "abort.ts"), `export default (pi) => {
      pi.on("tool_call", (_event, ctx) => {
        ctx.abort();
        return { block: true, reason: "cancelled by the test extension" };
      });
    };`);
    const runtime = defineRuntime({ id: "pi-aimock", installation: piInstallation, session: piSession });
    session = await runtimeUnderTest(runtime, env.env).startSession();
    const result = await promptAndWait(session, "call the tool", { timeoutMs: 10_000 });
    assert.equal(result.kind, "ended");
    assert.deepEqual(result.outcome, { kind: "aborted" });
    assert.equal(session.records().some((record) => record.kind === "request" && record.body.kind === "abort"), false);
    const settled = session.records().findLast((record) => record.kind === "frame" && record.body.type === "agent_settled");
    assert.equal(settled?.kind, "frame");
    assert.deepEqual(settled.body.native, { type: "agent_settled", aborted: true });
  } finally {
    await session?.dispose();
    await env.stop();
  }
}, 30_000);
