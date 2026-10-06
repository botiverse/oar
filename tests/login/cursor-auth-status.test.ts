import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { createCursorRuntime } from "../../packages/oar/src/index.js";
import { projectCursorAuthStatus } from "../../packages/oar/src/runtimes/cursor/auth-status.js";
import type { CursorAuthStatus } from "../../packages/oar/src/runtimes/cursor/sdk.js";
import { bundled, EXPIRES_MS, FakeCursor, KEY, leaks, unused } from "../fixtures/fake-cursor-auth.js";

test("authStatus is Cursor.auth.status: the account with the key's expiry, or logged out, never the key", async () => {
  // As if an SDK returned its key: it must still not come out.
  const keyed = { status: "logged-in", email: " user@example.com ", apiKeyExpiresAtMs: EXPIRES_MS, apiKey: KEY } as const;
  const stored: CursorAuthStatus[] = [keyed, { status: "logged-in" }, { status: "logged-out" }];
  const statuses = await Promise.all(stored.map(async (status) => new FakeCursor({ stored: status }).runtime().authStatus(bundled)));
  expect(statuses).toMatchInlineSnapshot(`
    [
      {
        "account": {
          "email": "user@example.com",
          "expiresAt": "2027-01-04T12:00:00.000Z",
        },
        "kind": "logged_in",
        "source": "Cursor.auth.status",
      },
      {
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
        "detail": "this @cursor/sdk has no Cursor.auth; OAR needs 1.0.35",
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
