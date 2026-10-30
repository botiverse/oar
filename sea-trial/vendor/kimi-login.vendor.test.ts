import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { kimiRuntime } from "../../packages/oar/src/runtimes/kimi/index.js";
import { recordedInteraction } from "../../tests/fixtures/login-interaction.js";
import { kimiLoginFixture } from "./support/kimi-login.js";

describe.skipIf(process.env.OAR_TEST !== "kimi-login")("Kimi native device login", () => {
  const installation = { kind: "available" as const, via: "executable" as const, command: process.env.OAR_KIMI_LOGIN_COMMAND ?? "kimi", version: "2.4.1" };
  test.each([true, false])("browser permission %s, native storage, status and logout", async (openBrowser) => {
    const fixture = await kimiLoginFixture();
    try {
      // No login, browser or session is triggered by an unauthenticated read.
      expect(await kimiRuntime.authStatus(installation, { env: fixture.env })).toEqual({ kind: "logged_out", source: "kimi acp authenticate" });
      expect(fixture.requests.filter((entry) => entry.path.startsWith("/api/oauth"))).toEqual([]);
      const before = await fixture.executions();
      expect(before.filter((entry) => /^(?:xdg-open|open|powershell\.exe)$/u.test(path.basename(entry.file)))).toEqual([]);
      const interaction = recordedInteraction([]);
      const result = await kimiRuntime.login(installation, interaction, { env: fixture.env, region: "global", openBrowser, timeoutMs: 30_000 });
      expect(result).toEqual({ kind: "logged_in" });
      expect(interaction.events).toEqual([{ kind: "device_code", userCode: "OAR-CODE", verificationUri: `${fixture.origin  }/device?code=OAR-CODE` }]);
      const executions = await fixture.executions();
      const calls = executions.filter((entry) => /^(?:xdg-open|open|powershell\.exe)$/u.test(path.basename(entry.file)));
      const launched = calls.filter((entry) => entry.pid !== undefined);
      expect(launched).toHaveLength(1);
      const executable = launched[0]?.file; assert.ok(executable !== undefined);
      if (openBrowser) { expect(executable).toBe(fixture.controlBrowser); }
      else {
        expect(executable).not.toBe(fixture.controlBrowser);
        expect(path.basename(path.dirname(executable))).toMatch(/^oar-kimi-browser-/u);
        expect(existsSync(executable)).toBe(false);
      }
      expect(calls.some((entry) => entry.file === executable && entry.code !== undefined)).toBe(true);
      const config = await readFile(path.join(fixture.home, "config.toml"), "utf8");
      expect(config).toContain("synthetic-model");
      expect(config).toContain("managed:kimi-code");
      expect(await kimiRuntime.authStatus(installation, { env: fixture.env })).toEqual({ kind: "logged_in", source: "kimi acp authenticate" });
      expect(await kimiRuntime.logout(installation, { env: fixture.env })).toEqual({ kind: "logged_out" });
      expect(await kimiRuntime.authStatus(installation, { env: fixture.env })).toEqual({ kind: "logged_out", source: "kimi acp authenticate" });
      expect(await readdir(path.join(fixture.home, "credentials"))).toEqual([]);
    } finally { await fixture.dispose(); }
  }, 60_000);
  test("cancels a pending device grant and re-reads status without starting another login", async () => {
    const fixture = await kimiLoginFixture("pending");
    try {
      const controller = new AbortController();
      const result = await kimiRuntime.login(installation, { signal: controller.signal, prompt: async () => "", onEvent: () => { controller.abort(); } }, { env: fixture.env, openBrowser: false });
      expect(result).toEqual({ kind: "cancelled" });
      const grants = fixture.requests.filter((entry) => entry.path === "/api/oauth/device_authorization").length;
      expect(grants).toBe(1);
      expect(await kimiRuntime.authStatus(installation, { env: fixture.env })).toEqual({ kind: "logged_out", source: "kimi acp authenticate" });
      expect(fixture.requests.filter((entry) => entry.path === "/api/oauth/device_authorization")).toHaveLength(grants);
    } finally { await fixture.dispose(); }
  }, 60_000);
  test("retains native credential writes when model provisioning fails", async () => {
    const fixture = await kimiLoginFixture("models-failed");
    try {
      expect(await kimiRuntime.login(installation, recordedInteraction([]), { env: fixture.env, openBrowser: false, timeoutMs: 30_000 })).toEqual({ kind: "failed", reason: "rejected", detail: "Kimi reported that login failed" });
      const credentials = await readdir(path.join(fixture.home, "credentials"));
      expect(credentials.length).toBeGreaterThan(0);
      // The credential exists, but native readiness cannot choose a model.
      expect(await kimiRuntime.authStatus(installation, { env: fixture.env })).toEqual({ kind: "logged_out", source: "kimi acp authenticate" });
    } finally { await fixture.dispose(); }
  }, 60_000);
});
