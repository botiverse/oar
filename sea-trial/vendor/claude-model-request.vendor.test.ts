import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { claudeInstallation, claudeRuntime } from "../../packages/oar/src/index.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { expectAvailable, runTurn } from "./support/asserts.js";

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("the latest Claude request is opt-in, attributed, and limited to the current open", async () => {
  const fixture = await startClaudeAimock(mock => { mock.onMessage(/[\s\S]*/u, { content: "fixture answer" }); });
  try {
    const installation = await claudeInstallation();
    expectAvailable(installation, "Claude");
    const canary = "scripted-credential-353";
    const options = { cwd: process.cwd(), systemPrompt: "OAR synthetic request system", env: { ...fixture.env, OAR_FIXTURE_TOKEN: canary } };
    const off = await claudeRuntime.session(installation, options);
    try { expect("lastModelRequest" in off).toBe(false); } finally { await off.dispose(); }
    const fresh = await claudeRuntime.session(installation, { ...options, modelRequests: "latest" });
    try {
      assert.ok(typeof fresh.lastModelRequest === "function");
      expect(await fresh.lastModelRequest()).toBeNull();
      expect(await runTurn(fresh, `first request: ${canary}`)).toEqual({ kind: "completed" });
      const request = await fresh.lastModelRequest();
      expect(request).toMatchObject({ format: "anthropic.messages", provider: "firstParty" });
      expect(request?.body).toHaveProperty("tools");
      const json = JSON.stringify(request?.body);
      expect(json).toContain("OAR synthetic request system");
      expect(json).toContain("first request: [redacted]");
      expect(json).not.toContain(canary);
      expect(await runTurn(fresh, "second request")).toEqual({ kind: "completed" });
      const second = await fresh.lastModelRequest();
      expect(JSON.stringify(second?.body)).toContain("second request");
    } finally {
      const disposed = fresh.dispose();
      expect(await fresh.lastModelRequest?.()).toBeNull();
      await disposed;
    }
    const resumed = await claudeRuntime.session(installation, { ...options, resume: fresh.id, modelRequests: "latest" });
    try {
      assert.ok(typeof resumed.lastModelRequest === "function");
      expect(await resumed.lastModelRequest()).toBeNull();
      expect(await runTurn(resumed, "resumed request")).toEqual({ kind: "completed" });
      const next = await resumed.lastModelRequest();
      expect(JSON.stringify(next?.body)).toContain("resumed request");
    } finally { await resumed.dispose(); }
  } finally { await fixture.stop(); }
}, 60_000);
