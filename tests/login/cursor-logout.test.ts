import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import { createCursorRuntime } from "../../packages/oar/src/index.js";
import { bundled, EXPIRES_MS, FakeCursor, KEY, leaks, PREVIOUS, unused } from "../fixtures/fake-cursor-auth.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("Cursor.auth.logout with the SDK's own store, then Cursor.auth.status reads logged out; again when already out", async () => {
  const fake = new FakeCursor({ stored: PREVIOUS });
  const runtime = fake.runtime();
  assert.deepEqual(await runtime.logout(bundled), { kind: "logged_out" });
  const status = await runtime.authStatus(bundled);
  assert.equal(status.kind, "logged_out");
  assert.deepEqual(await runtime.logout(bundled), { kind: "logged_out" });
  // No store passed: the SDK clears its own default, the file its status reads.
  assert.deepEqual(fake.logouts, [[], []]);
});

test("CURSOR_API_KEY is not touched, and the status, which ignores it, decides", async () => {
  vi.stubEnv("CURSOR_API_KEY", KEY);
  const result = await new FakeCursor({ stored: PREVIOUS }).runtime().logout(bundled);
  assert.deepEqual(result, { kind: "logged_out" });
  assert.equal(process.env.CURSOR_API_KEY, KEY);
});

test("a status still logged in is still_logged_in; a throw is rejected and redacted; no answer within the deadline is timed_out", async () => {
  const keyed = { status: "logged-in", email: "user@example.com", apiKeyExpiresAtMs: EXPIRES_MS } as const;
  const results = await Promise.all([
    new FakeCursor({ stored: PREVIOUS, afterLogout: keyed }).runtime().logout(bundled),
    new FakeCursor({ stored: PREVIOUS, logoutError: new Error("EACCES: permission denied, unlink '/home/u/.cursor/sdk/auth.json' (sk-ant-oat01-abcdefghijklmnopqrstuvwxyz)\n    at rm (node:fs)") }).runtime().logout(bundled),
    new FakeCursor({ stored: PREVIOUS, logoutError: "never" }).runtime().logout(bundled, { timeoutMs: 20 }),
    // The status decides: a logout that never answered, over a login that is gone, is logged_out.
    new FakeCursor({ logoutError: "never" }).runtime().logout(bundled, { timeoutMs: 20 }),
  ]);
  assert.ok(!leaks(results));
  expect(results).toMatchInlineSnapshot(`
    [
      {
        "detail": "Cursor.auth.logout succeeded, yet Cursor.auth.status still reads logged in (user@example.com)",
        "kind": "failed",
        "reason": "still_logged_in",
      },
      {
        "detail": "EACCES: permission denied, unlink '/home/u/.cursor/sdk/auth.json' ([redacted])",
        "kind": "failed",
        "reason": "rejected",
      },
      {
        "detail": "Cursor.auth.logout did not finish within 20 ms",
        "kind": "failed",
        "reason": "timed_out",
      },
      {
        "kind": "logged_out",
      },
    ]
  `);
});

test("an SDK without Cursor.auth.logout, an installation that is not bundled, or an SDK that fails to load", async () => {
  const results = await Promise.all([
    new FakeCursor({ noLogout: true }).runtime().logout(bundled),
    createCursorRuntime({ sdk: async () => ({ Agent: new FakeCursor().sdk.Agent, Cursor: { models: { list: unused } } }) }).logout(bundled),
    new FakeCursor().runtime().logout({ kind: "available", via: "executable", command: "cursor-agent" }),
    createCursorRuntime({
      sdk: async () => {
        throw new Error("Cannot find package '@cursor/sdk'");
      },
    }).logout(bundled),
  ]);
  expect(results).toMatchInlineSnapshot(`
    [
      {
        "detail": "@cursor/sdk 1.0.36 is required; this one has no Cursor.auth.logout",
        "kind": "unsupported",
        "reason": "version_unsupported",
      },
      {
        "detail": "@cursor/sdk 1.0.36 is required; this one has no Cursor.auth.logout",
        "kind": "unsupported",
        "reason": "version_unsupported",
      },
      {
        "detail": "cursor signs out through the bundled @cursor/sdk",
        "kind": "unsupported",
        "reason": "unsupported_installation",
      },
      {
        "detail": "cursor could not load @cursor/sdk through the host's sdk loader",
        "kind": "failed",
        "reason": "process_failed",
      },
    ]
  `);
  assert.ok(!leaks(results));
});
