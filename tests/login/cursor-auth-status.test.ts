import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createCursorRuntime, orient, RuntimeRegistry } from "../../packages/oar/src/index.js";
import { projectCursorAuthStatus } from "../../packages/oar/src/runtimes/cursor/auth-status.js";
import type { CursorAuthStatus } from "../../packages/oar/src/runtimes/cursor/sdk.js";
import { bundled, EXPIRES_MS, FakeCursor, KEY, leaks, unused } from "../fixtures/fake-cursor-auth.js";

beforeEach(() => { vi.stubEnv("CURSOR_API_KEY", undefined); });
afterEach(() => { vi.unstubAllEnvs(); });

test.each(["environment-key", ""])("an environment key hides unrelated stored-login identity (%j)", async (key) => {
  vi.stubEnv("CURSOR_API_KEY", key);
  await Promise.all(([{ status: "logged-out" }, { status: "logged-in", email: "stale@example.invalid", apiKeyExpiresAtMs: EXPIRES_MS }] as const).map(async (stored) => {
    const result = await new FakeCursor({ stored }).runtime().authStatus(bundled);
    expect(result).toEqual({ kind: "unknown", configured: ["environment: CURSOR_API_KEY"], detail: "Sessions use CURSOR_API_KEY from the environment; Cursor.auth.status neither reads nor validates that key.", source: "Cursor.auth.status" });
    expect(result).not.toHaveProperty("account");
    if (key !== "") { expect(JSON.stringify(result)).not.toContain(key); }
  }));
});

test("authStatus is Cursor.auth.status: the account with the key's expiry, or logged out, never the key", async () => {
  // As if an SDK returned its key: it must still not come out.
  const keyed = { status: "logged-in", email: " user@example.com ", apiKeyExpiresAtMs: EXPIRES_MS, apiKey: KEY } as const;
  const stored: CursorAuthStatus[] = [keyed, { status: "logged-in" }, { status: "logged-out" }];
  const statuses = await Promise.all(stored.map(async (status) => new FakeCursor({ stored: status }).runtime().authStatus(bundled)));
  expect(statuses).toMatchInlineSnapshot(`
    [
      {
        "account": {
          "credential": "api_key",
          "email": "user@example.com",
          "expiresAt": "2027-01-04T12:00:00.000Z",
          "metering": "plan",
        },
        "kind": "logged_in",
        "source": "Cursor.auth.status",
      },
      {
        "account": {
          "credential": "api_key",
          "metering": "plan",
        },
        "kind": "logged_in",
        "source": "Cursor.auth.status",
      },
      {
        "kind": "logged_out",
        "source": "Cursor.auth.status",
      },
    ]
  `);
  assert.ok(!leaks(statuses));
});

test("a status that fails, never answers or cannot be read is unknown, never a guess", async () => {
  const statuses = await Promise.all([
    new FakeCursor({ stored: new Error("Unexpected token in JSON, near sk-ant-oat01-abcdefghijklmnopqrstuvwxyz") }).runtime().authStatus(bundled),
    new FakeCursor({ stored: "never" }).runtime().authStatus(bundled, { timeoutMs: 20 }),
    new FakeCursor().runtime().authStatus({ kind: "available", via: "executable", command: "cursor-agent" }),
    createCursorRuntime({ sdk: async () => ({ Agent: new FakeCursor().sdk.Agent, Cursor: { models: { list: unused } } }) }).authStatus(bundled),
    createCursorRuntime({
      sdk: async () => {
        throw new Error("Cannot find package '@cursor/sdk'");
      },
    }).authStatus(bundled),
  ]);
  expect([...statuses, projectCursorAuthStatus({ status: "expired" }), projectCursorAuthStatus(null)]).toMatchInlineSnapshot(`
    [
      {
        "detail": "Unexpected token in JSON, near [redacted]",
        "kind": "unknown",
        "source": "Cursor.auth.status",
      },
      {
        "detail": "Cursor.auth.status did not answer within 20 ms",
        "kind": "unknown",
        "source": "Cursor.auth.status",
      },
      {
        "detail": "cursor's sign-in status needs the bundled @cursor/sdk",
        "kind": "unknown",
      },
      {
        "detail": "this @cursor/sdk has no Cursor.auth; OAR needs 1.1.0",
        "kind": "unknown",
      },
      {
        "detail": "cursor could not load @cursor/sdk through the host's sdk loader",
        "kind": "unknown",
      },
      {
        "detail": "Cursor.auth.status gave an answer oar cannot read",
        "kind": "unknown",
        "source": "Cursor.auth.status",
      },
      {
        "detail": "Cursor.auth.status gave an answer oar cannot read",
        "kind": "unknown",
        "source": "Cursor.auth.status",
      },
    ]
  `);
});


test("orient observes Cursor in its host environment when sessions refuse env", async () => {
  const cursor = new FakeCursor({ stored: { status: "logged-in", email: "host@example.invalid" } }).runtime();
  const report = await orient(new RuntimeRegistry([cursor]), { depth: "account", env: { CURSOR_API_KEY: "overlay-must-not-reach-sdk" } });
  expect(report.runtimes[0]?.installation).toMatchObject({ kind: "ok", value: { kind: "available", via: "bundled" } });
  expect(report.runtimes[0]?.auth).toMatchObject({ kind: "ok", value: { kind: "logged_in", account: { email: "host@example.invalid" } } });
  expect(process.env.CURSOR_API_KEY).toBeUndefined();
});

test("orient preserves the configured source without exposing the Cursor key", async () => {
  vi.stubEnv("CURSOR_API_KEY", KEY);
  const report = await orient(new RuntimeRegistry([new FakeCursor().runtime()]));
  expect(report.runtimes[0]?.auth).toMatchObject({ kind: "ok", value: { kind: "unknown", configured: ["environment: CURSOR_API_KEY"] } });
  assert.ok(!leaks(report));
});
