import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { codebuddyLogin } from "../../packages/oar/src/runtimes/codebuddy/login.js";
import { codebuddyAuthStatus, projectCodebuddyAuthStatus } from "../../packages/oar/src/runtimes/codebuddy/auth-status.js";
import { fakeLoginCli } from "../fixtures/login-fixtures.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";

const directories: string[] = [];
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
      "reason": "rejected",
    }
  `);
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
