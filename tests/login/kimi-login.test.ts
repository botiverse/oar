import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { kimiRuntime } from "../../packages/oar/src/runtimes/kimi/index.js";
import { kimiCanResolveBrowser } from "../../packages/oar/src/runtimes/kimi/login-browser.js";
import { fakeLoginCli, type FakeCli } from "../fixtures/login-fixtures.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }));
});
async function fixture(mode: string, loggedIn = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-kimi-login-test-")); directories.push(dir);
  const fake = fakeLoginCli({ dir, name: "kimi", script: "fake-kimi-login.mjs", state: { mode, loggedIn } });
  return { fake, installation: { kind: "available" as const, via: "executable" as const, command: fake.command, version: "2.3.3" } };
}

function assertStopped(fake: FakeCli): void {
  const { pids } = fake.read();
  assert.ok(Array.isArray(pids));
  for (const pid of pids) { expect(() => process.kill(Number(pid), 0)).toThrow(); }
}

it("relays native device codes, passes the region and removes the per-login browser helper", async () => {
  const { fake, installation } = await fixture("reissue");
  const interaction = recordedInteraction([]);
  expect(await kimiRuntime.login(installation, interaction, { region: "global", openBrowser: false })).toMatchInlineSnapshot(`
    {
      "kind": "logged_in",
    }
  `);
  expect(interaction.events).toMatchInlineSnapshot(`
    [
      {
        "kind": "device_code",
        "userCode": "CODE-ONE",
        "verificationUri": "https://login.example.invalid/device",
      },
      {
        "kind": "device_code",
        "userCode": "CODE-TWO",
        "verificationUri": "https://login.example.invalid/device",
      },
    ]
  `);
  expect(fake.read().calls).toEqual([["login", "--region", "global"], ["acp"]]);
  expect(fake.read().methods).toEqual(["initialize", "authenticate"]);
  expect(fake.read().authParams).toEqual({ methodId: "login" });
  const helperDirectory = String(fake.read().browserPath);
  expect(existsSync(helperDirectory)).toBe(false);
});
it("leaves an omitted region to native login and reuses its existing credentials", async () => {
  const { fake, installation } = await fixture("existing", true);
  const interaction = recordedInteraction([]);
  const result = await kimiRuntime.login(installation, interaction);
  expect(result.kind).toBe("logged_in");
  expect(fake.read().calls).toEqual([["login"], ["acp"]]);
  expect(interaction.events).toEqual([]);
});
it("keeps native failure details private", async () => {
  const { installation } = await fixture("failure");
  expect(await kimiRuntime.login(installation, recordedInteraction([]))).toMatchInlineSnapshot(`
    {
      "detail": "Kimi reported that login failed",
      "kind": "failed",
      "reason": "rejected",
    }
  `);
});
it("rejects a native success contradicted by the status query", async () => {
  const { installation } = await fixture("false-success");
  expect(await kimiRuntime.login(installation, recordedInteraction([]))).toMatchInlineSnapshot(`
    {
      "detail": "Kimi reported login success but its authentication check still requires login",
      "kind": "failed",
      "reason": "not_logged_in",
    }
  `);
});
it("aborts the login and removes its helper before returning", async () => {
  const { fake, installation } = await fixture("wait", true);
  const controller = new AbortController();
  expect(await kimiRuntime.login(installation, { signal: controller.signal, onEvent: () => { controller.abort(); }, prompt: async () => "" }, { openBrowser: false })).toMatchInlineSnapshot(`
    {
      "kind": "cancelled",
    }
  `);
  const helperDirectory = String(fake.read().browserPath);
  expect(existsSync(helperDirectory)).toBe(false);
  expect(fake.read().methods).toBeUndefined();
  assertStopped(fake);
});
it("bounds login and handles a failed device-code callback", async () => {
  const first = await fixture("wait");
  expect(await kimiRuntime.login(first.installation, recordedInteraction([]), { timeoutMs: 200 })).toMatchInlineSnapshot(`
    {
      "detail": "no sign-in within 200 ms",
      "kind": "failed",
      "reason": "timed_out",
    }
  `);
  const second = await fixture("wait");
  expect(await kimiRuntime.login(second.installation, { prompt: async () => "", onEvent: () => { throw new Error("private callback"); } })).toMatchInlineSnapshot(`
    {
      "detail": "Could not present the Kimi device code",
      "kind": "failed",
      "reason": "interaction_failed",
    }
  `);
});
it("reads authentication without login or a session and keeps ACP stderr private", async () => {
  const { fake, installation } = await fixture("success");
  vi.stubEnv("OAR_CHILD_STDERR", "inherit");
  const output = vi.spyOn(process.stderr, "write");
  expect(await kimiRuntime.authStatus(installation)).toMatchInlineSnapshot(`
    {
      "kind": "logged_out",
      "source": "kimi acp authenticate",
    }
  `);
  expect(fake.read().calls).toEqual([["acp"]]);
  expect(fake.read().methods).toEqual(["initialize", "authenticate"]);
  expect(output).not.toHaveBeenCalled();
});
it("reports unknown for status-timeout", async () => {
  const { installation } = await fixture("status-timeout");
  expect(await kimiRuntime.authStatus(installation, { timeoutMs: 300 })).toMatchInlineSnapshot(`
    {
      "detail": "Kimi authentication query timed out",
      "kind": "unknown",
      "source": "kimi acp authenticate",
    }
  `);
});
it("reports unknown for status-error", async () => {
  const { installation } = await fixture("status-error");
  expect(await kimiRuntime.authStatus(installation, { timeoutMs: 20_000 })).toMatchInlineSnapshot(`
    {
      "detail": "Kimi authentication query failed",
      "kind": "unknown",
      "source": "kimi acp authenticate",
    }
  `);
});
it("reports unknown for no-auth", async () => {
  const { installation } = await fixture("no-auth");
  expect(await kimiRuntime.authStatus(installation, { timeoutMs: 20_000 })).toMatchInlineSnapshot(`
    {
      "detail": "This Kimi build does not expose the authentication check",
      "kind": "unknown",
      "source": "kimi acp authenticate",
    }
  `);
});
it("uses the same environment for login, authentication and logout without changing the host", async () => {
  const { fake, installation } = await fixture("success");
  vi.stubEnv("OAR_KIMI_DELETE", "host-value");
  const env = { KIMI_CODE_HOME: "isolated-home", OAR_KIMI_DELETE: null, OAR_KIMI_MARKER: "value" };
  const login = await kimiRuntime.login(installation, recordedInteraction([]), { env });
  expect(login.kind).toBe("logged_in");
  expect(await kimiRuntime.logout(installation, { env })).toMatchInlineSnapshot(`
    {
      "kind": "logged_out",
    }
  `);
  expect(fake.read().environments).toEqual(Array.from({ length: 4 }, () => ({ home: "isolated-home", marker: "value" })));
  expect(fake.read().methods).toEqual(["initialize", "authenticate", "initialize", "logout", "initialize", "authenticate"]);
  expect(process.env.OAR_KIMI_DELETE).toBe("host-value");
});
it("does not claim logout cleared credentials from another source", async () => {
  const { installation } = await fixture("success", true);
  expect(await kimiRuntime.logout(installation, { env: { OAR_KIMI_MARKER: "api-key" } })).toMatchInlineSnapshot(`
    {
      "detail": "kimi acp logout succeeded, yet kimi acp authenticate still reads logged in",
      "kind": "failed",
      "reason": "still_logged_in",
    }
  `);
});
it("refuses an unavailable native logout rather than deleting files", async () => {
  const { installation } = await fixture("no-logout", true);
  expect(await kimiRuntime.logout(installation)).toMatchInlineSnapshot(`
    {
      "detail": "This Kimi build has no ACP logout",
      "kind": "unsupported",
      "reason": "version_unsupported",
    }
  `);
});
it("recognizes the native workspace exclusion on every platform", () => {
  expect(kimiCanResolveBrowser("/tmp/browser/open", "/tmp", "darwin")).toBe(false);
  expect(kimiCanResolveBrowser("/tmp/browser/open", "/", "darwin")).toBe(true);
  expect(kimiCanResolveBrowser("/tmp/browser/open", "/work", "linux")).toBe(true);
  expect(kimiCanResolveBrowser(String.raw`C:\TEMP\browser\powershell.exe`, String.raw`c:\temp`, "win32")).toBe(false);
  expect(kimiCanResolveBrowser(String.raw`D:\temp\browser\powershell.exe`, String.raw`C:\work`, "win32")).toBe(true);
});

it("refuses browser suppression before launch when Kimi would exclude the helper", async () => {
  const { fake, installation } = await fixture("success");
  for (const name of ["TMPDIR", "TMP", "TEMP"]) { vi.stubEnv(name, process.cwd()); }
  expect(await kimiRuntime.login(installation, recordedInteraction([]), { openBrowser: false })).toMatchInlineSnapshot(`
    {
      "detail": "Kimi cannot safely suppress its browser on this machine; use a temporary directory outside the working directory or allow local browser opening",
      "kind": "unsupported",
      "reason": "browser_suppression_unavailable",
    }
  `);
  expect(fake.read().calls).toBeUndefined();
});
it("aborts the confirmation query after native success without undoing that success", async () => {
  const { fake, installation } = await fixture("status-timeout");
  const controller = new AbortController();
  const result = kimiRuntime.login(installation, recordedInteraction([], { signal: controller.signal }));
  await vi.waitFor(() => { expect(fake.read().calls).toEqual([["login"], ["acp"]]); }, { timeout: 10_000 });
  controller.abort();
  expect(await result).toMatchInlineSnapshot(`
    {
      "kind": "logged_in",
    }
  `);
  assertStopped(fake);
});
