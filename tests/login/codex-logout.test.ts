import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { codexLogout } from "../../packages/oar/src/runtimes/codex/logout.js";
import { fakeLoginCli, reportedPid, type FakeCli } from "../fixtures/login-fixtures.js";
import { gone } from "../fixtures/process-tree.js";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oar-codex-logout-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let fakes = 0;
function fakeCodex(state: Record<string, unknown> = {}): FakeCli {
  fakes += 1;
  return fakeLoginCli({
    dir,
    name: `codex-${String(fakes)}`,
    script: "fake-codex-login.mjs",
    state: { version: "0.160.1", email: "user@example.com", loggedIn: true, ...state },
  });
}

function installation(fake: FakeCli, version = "codex-cli 0.160.1"): Parameters<typeof codexLogout>[0] {
  return { kind: "available", via: "executable", command: fake.command, version };
}

test("codex logout signs out and codex login status reads logged out; again when already out", async () => {
  const fake = fakeCodex();
  assert.deepEqual(await codexLogout(installation(fake)), { kind: "logged_out" });
  assert.equal(fake.read().loggedIn, false);
  // `Not logged in`, exit 0: the status decides.
  assert.deepEqual(await codexLogout(installation(fake)), { kind: "logged_out" });
  assert.deepEqual(fake.read().invocations, ["logout", "login status", "logout", "login status"]);
});

test("codex's failure is rejected in its words; a status still logged in is still_logged_in; no answer is never logged_out", async () => {
  const codexes = [fakeCodex({ logoutMode: "error" }), fakeCodex({ logoutMode: "keeps" }), fakeCodex({ status: "broken" })];
  const results = await Promise.all(codexes.map(async (fake) => codexLogout(installation(fake))));
  expect(results).toMatchInlineSnapshot(`
    [
      {
        "detail": "Error logging out: failed to delete /home/user/.codex/auth.json: Permission denied (os error 13)",
        "kind": "failed",
        "reason": "rejected",
      },
      {
        "detail": "codex logout succeeded, yet codex login status still reads logged in (chatgpt)",
        "kind": "failed",
        "reason": "still_logged_in",
      },
      {
        "detail": "codex logout succeeded, yet codex login status gave no answer: Error loading configuration: invalid TOML",
        "kind": "failed",
        "reason": "process_failed",
      },
    ]
  `);
});

test("past the deadline the logout is stopped with everything it started (its tree on Windows)", async () => {
  const fake = fakeCodex({ logoutMode: "hang" });
  expect(await codexLogout(installation(fake), { timeoutMs: 1000 })).toMatchInlineSnapshot(`
    {
      "detail": "codex logout did not finish within 1000 ms",
      "kind": "failed",
      "reason": "timed_out",
    }
  `);
  assert.ok(await gone(reportedPid(fake, "pid")), "codex logout outlived the deadline");
  assert.ok(await gone(reportedPid(fake, "workerPid")), "a process codex started outlived the deadline");
});

test("a codex without logout, an installation that is not an executable, or a missing one runs nothing", async () => {
  const fake = fakeCodex();
  const results = await Promise.all([
    codexLogout(installation(fake, "codex-cli 0.14.0")),
    codexLogout({ kind: "available", via: "bundled" }),
    codexLogout({ kind: "available", via: "executable", command: "no-such-codex-for-oar-tests", version: "0.160.1" }),
  ]);
  expect(results).toMatchInlineSnapshot(`
    [
      {
        "detail": "codex 0.15.0 or later is required; this is 0.14.0",
        "kind": "unsupported",
        "reason": "version_unsupported",
      },
      {
        "detail": "not a machine-installed executable",
        "kind": "unsupported",
        "reason": "unsupported_installation",
      },
      {
        "detail": "codex executable not found: no-such-codex-for-oar-tests",
        "kind": "failed",
        "reason": "process_failed",
      },
    ]
  `);
  assert.equal(fake.read().invocations, undefined);
});
