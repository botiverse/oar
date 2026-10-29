import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { codebuddyLogin } from "../../packages/oar/src/runtimes/codebuddy/login.js";
import { codebuddyAuthStatus, projectCodebuddyAuthStatus } from "../../packages/oar/src/runtimes/codebuddy/auth-status.js";
import { fakeLoginCli } from "../fixtures/login-fixtures.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";

const directories: string[] = [];
beforeEach(() => { vi.stubEnv("CODEBUDDY_API_KEY", undefined); });
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }); })); });
async function fixture(mode: string, loggedIn = false) {
const dir = await mkdtemp(path.join(tmpdir(), "oar-codebuddy-login-")); directories.push(dir);
const fake = fakeLoginCli({ dir, name: "codebuddy", script: "fake-codebuddy-login.mjs", state: { mode, loggedIn } });
return { fake, installation: { kind: "available" as const, via: "executable" as const, command: fake.command, version: "2.178.1" } };
}

it("only projects account presence, never the token-bearing object", () => {
  expect(projectCodebuddyAuthStatus({ account: { token: "private-token", email: "private@example.invalid" } })).toMatchInlineSnapshot(`
    {
      "kind": "logged_in",
      "source": "codebuddy stream-json initialize.account",
    }
  `);
  expect(projectCodebuddyAuthStatus({}).kind).toBe("unknown");
  expect(projectCodebuddyAuthStatus({ account: null }).kind).toBe("logged_out");
});
it("relays the URL, confirms through a new process and preserves the selected environment", async () => {
  vi.stubEnv("CODEBUDDY_INTERNET_ENVIRONMENT", "internal");
  const { fake, installation } = await fixture("success");
  const interaction = recordedInteraction([]);
  expect(await codebuddyLogin(installation, interaction, { openBrowser: false, env: { CODEBUDDY_INTERNET_ENVIRONMENT: "global" } })).toMatchInlineSnapshot(`
    {
      "kind": "logged_in",
    }
  `);
  expect(interaction.events).toMatchInlineSnapshot(`
    [
      {
        "instructions": "Open this URL to sign in to CodeBuddy.",
        "kind": "auth_url",
        "url": "https://www.codebuddy.ai/login?state=synthetic-state",
      },
    ]
  `);
  expect(fake.read().requests).toEqual([{ subtype: "initialize" }, { subtype: "authenticate" }, { subtype: "initialize" }]);
  expect(fake.read().environment).toBe("global");
  expect(fake.read().pids).toHaveLength(2);
  const { browsers } = fake.read();
  expect(Array.isArray(browsers) ? browsers[0] : undefined).toBe(process.platform === "win32" ? path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "hostname.exe") : "true");
});
it("cancellation preserves the existing native login", async () => {
  const { fake, installation } = await fixture("cancel", true);
  const abort = new AbortController();
  const result = await codebuddyLogin(installation, { signal: abort.signal, prompt: async () => "", onEvent: () => { abort.abort(); } });
  expect(result).toMatchInlineSnapshot(`
    {
      "kind": "cancelled",
    }
  `);
  expect(fake.read().loggedIn).toBe(true);
});
it("times out a silent status query without claiming logged out", async () => {
  const { installation } = await fixture("silent");
  expect(await codebuddyAuthStatus(installation, { timeoutMs: 100 })).toMatchInlineSnapshot(`
    {
      "detail": "CodeBuddy account query timed out",
      "kind": "unknown",
      "source": "codebuddy stream-json initialize.account",
    }
  `);
});
it("redacts tokens in native failure details", async () => {
  const { installation } = await fixture("rejected", true);
  const result = await codebuddyLogin(installation, recordedInteraction([]));
  expect(result).toMatchInlineSnapshot(`
    {
      "detail": "Rejected token [redacted]",
      "kind": "failed",
      "reason": "process_failed",
    }
  `);
});

it.each(["initialize-error", "authenticate-error", "auth_failed"])("%s is a process failure, not an authorization denial", async (mode) => {
  const { installation } = await fixture(mode);
  const result = await codebuddyLogin(installation, recordedInteraction([]));
  assert.equal(result.kind, "failed");
  expect(result.reason).toBe("process_failed");
  expect(typeof result.detail).toBe("string");
  expect(JSON.stringify(result)).not.toContain("synthetic-private-codebuddy-access-token");
});

it("redacts known account identity from native control errors", async () => {
  const { installation } = await fixture("identity-error", true);
  const result = await codebuddyLogin(installation, recordedInteraction([]));
  assert.equal(result.kind, "failed");
  expect(result.reason).toBe("process_failed");
  expect(result.detail).toContain("[redacted]");
  for (const value of ["synthetic-private-codebuddy-access-token", "private@example.invalid", "private-uid", "private-user-id", "private-nickname", "private-enterprise", "private-enterprise-id"]) {
    expect(JSON.stringify(result)).not.toContain(value);
  }
});

it.each(["timeout", "native-timeout"])("%s settles as timed_out and stops the login process", async (mode) => {
  const { fake, installation } = await fixture(mode);
  const result = await codebuddyLogin(installation, recordedInteraction([]), { timeoutMs: 1500 });
  expect(result).toMatchObject({ kind: "failed", reason: "timed_out" });
  expect(fake.read().loggedIn).toBe(false);
  const { pids } = fake.read();
  assert.ok(Array.isArray(pids));
  for (const pid of pids) { expect(() => process.kill(Number(pid), 0)).toThrow(); }
  expect(JSON.stringify(result)).not.toContain("synthetic-private-codebuddy-access-token");
}, 5000);

it("native cancellation is not mislabeled as a timeout or denial", async () => {
  const { installation } = await fixture("native-cancelled");
  expect(await codebuddyLogin(installation, recordedInteraction([]))).toEqual({ kind: "cancelled" });
});

it("a cancelled status query does not claim a timeout", async () => {
  const { installation } = await fixture("silent");
  const abort = new AbortController();
  const pending = codebuddyAuthStatus(installation, {}, abort.signal);
  abort.abort();
  expect(await pending).toEqual({ kind: "unknown", source: "codebuddy stream-json initialize.account", detail: "CodeBuddy account query cancelled" });
});

it.each([false, true])("an environment key reports configuration rather than account identity (stored login %j)", async (loggedIn) => {
  const { fake, installation } = await fixture("success", loggedIn);
  const key = "synthetic-environment-credential";
  const result = await codebuddyAuthStatus(installation, { env: { CODEBUDDY_API_KEY: key, CODEBUDDY_BASE_URL: "https://private-provider.invalid/v1" } });
  expect(result).toMatchObject({ kind: "unknown", configured: ["environment: CODEBUDDY_API_KEY"] });
  expect(result).not.toHaveProperty("account");
  expect(fake.read().requests).toBeUndefined();
  expect(JSON.stringify(result)).not.toMatch(/synthetic-environment-credential|private-provider/u);
});

it("key overlays inherit, replace and remove configuration without changing the host", async () => {
  const { installation } = await fixture("success");
  vi.stubEnv("CODEBUDDY_API_KEY", "inherited-private-key");
  expect(await codebuddyAuthStatus(installation)).toHaveProperty("configured", ["environment: CODEBUDDY_API_KEY"]);
  expect(await codebuddyAuthStatus(installation, { env: { CODEBUDDY_API_KEY: "replacement" } })).toHaveProperty("configured", ["environment: CODEBUDDY_API_KEY"]);
  expect(await codebuddyAuthStatus(installation, { env: { CODEBUDDY_API_KEY: null } })).toMatchObject({ kind: "logged_out" });
  expect(await codebuddyAuthStatus(installation, { env: { CODEBUDDY_API_KEY: "" } })).toMatchObject({ kind: "logged_out" });
  expect(process.env.CODEBUDDY_API_KEY).toBe("inherited-private-key");
});
it("fails when a success is contradicted by native status", async () => {
  const { installation } = await fixture("false-success");
  expect(await codebuddyLogin(installation, recordedInteraction([]))).toMatchInlineSnapshot(`
    {
      "detail": "CodeBuddy reported success but its account query reads logged out",
      "kind": "failed",
      "reason": "not_logged_in",
    }
  `);
});
it("stops when the host cannot display the link", async () => {
  const { fake, installation } = await fixture("cancel", true);
  expect(await codebuddyLogin(installation, { prompt: async () => "", onEvent: () => { throw new Error("UI closed"); } })).toMatchInlineSnapshot(`
    {
      "detail": "UI closed",
      "kind": "failed",
      "reason": "interaction_failed",
    }
  `);
  expect(fake.read().loggedIn).toBe(true);
});

it("a silent confirmation shares the whole login deadline and cannot contradict native success", async () => {
  const { fake, installation } = await fixture("silent-confirmation");
  expect(await codebuddyLogin(installation, recordedInteraction([]), { timeoutMs: 1500 })).toEqual({ kind: "logged_in" });
  expect(fake.read().pids).toHaveLength(2);
  expect(fake.read().loggedIn).toBe(true);
}, 5000);
