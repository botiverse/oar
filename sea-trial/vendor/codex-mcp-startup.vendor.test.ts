import assert from "node:assert/strict";
import { expect, onTestFinished, test } from "vitest";
import { codexRuntime, mcpStartupOf, promptAndWait, serveMcpTools } from "../../packages/oar/src/index.js";
import { startCodexAimock } from "../harness/aimock.js";
import { ALPHA, defined, loggingProxy } from "./support/tools-list-changed.js";

test.skipIf(process.env.OAR_TEST !== "codex-aimock")("Codex reports startup for each server before input, and the ready tool reaches the first model request", async () => {
  const installation = await codexRuntime.installation();
  assert.ok(installation.kind === "available");
  const provider = await startCodexAimock(undefined, { captureRaw: true });
  onTestFinished(async () => { await provider.stop(); });
  assert.ok(provider.env !== undefined);
  const served = await serveMcpTools({
    name: "held",
    tools: [{ name: ALPHA, description: "Controlled tool", inputSchema: { type: "object", properties: {} }, handler: () => "ok" }],
  });
  onTestFinished(async () => { await served.close(); });
  const release = Promise.withResolvers<void>();
  const proxy = await loggingProxy(served, [], async () => release.promise);
  onTestFinished(async () => { release.resolve(); await proxy.close(); });
  const session = await codexRuntime.session(installation, {
    cwd: process.cwd(), env: provider.env,
    mcpServers: [{ name: "held", type: "http", url: proxy.url }, { name: "broken", command: process.execPath, args: ["-e", "process.exit(1)"] }],
  });
  onTestFinished(async () => { release.resolve(); await session.dispose(); });
  await expect.poll(() => Object.fromEntries(mcpStartupOf(session.records(), session.id)), { timeout: 15_000 })
    .toEqual({ broken: "failed", held: "pending" });
  expect(provider.raw).toHaveLength(0);
  release.resolve();
  await expect.poll(() => mcpStartupOf(session.records(), session.id).get("held"), { timeout: 15_000 }).toBe("ready");
  expect(await promptAndWait(session, "Say ok.", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
  expect(defined(provider.raw[0]?.body)).toContain(ALPHA);
}, 60_000);
