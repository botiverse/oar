import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { claudeLogout } from "../../packages/oar/src/runtimes/claude/logout.js";
import { fakeLoginCli, reportedPid, type FakeCli } from "../fixtures/login-fixtures.js";
import { gone } from "../fixtures/process-tree.js";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oar-claude-logout-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let fakes = 0;
function fakeClaude(state: Record<string, unknown> = {}): FakeCli {
  fakes += 1;
  return fakeLoginCli({
    dir,
    name: `claude-${String(fakes)}`,
    script: "fake-claude-login.mjs",
    state: { version: "2.1.292", email: "user@example.com", loggedIn: true, ...state },
  });
}

function installation(fake: FakeCli, version = "2.1.292 (Claude Code)"): Parameters<typeof claudeLogout>[0] {
  return { kind: "available", via: "executable", command: fake.command, version };
}

test("claude auth logout signs out, and the status reads logged out; again when already out", async () => {
  const fake = fakeClaude();
  assert.deepEqual(await claudeLogout(installation(fake)), { kind: "logged_out" });
  assert.equal(fake.read().loggedIn, false);
  assert.equal(fake.read().sawClaudeCode, false);
  // claude answers the same when nothing is stored; the status decides.
  assert.deepEqual(await claudeLogout(installation(fake)), { kind: "logged_out" });
});

test("the logout's stdin is closed, so a claude reading it is not left waiting", async () => {
  const fake = fakeClaude({ logoutMode: "stdin" });
  assert.deepEqual(await claudeLogout(installation(fake), { timeoutMs: 5000 }), { kind: "logged_out" });
});

test("an API key in the environment still reads logged in: still_logged_in, saying what the status read", async () => {
  const fake = fakeClaude({ envKey: true });
  expect(await claudeLogout(installation(fake))).toMatchInlineSnapshot(`
    {
      "detail": "claude auth logout succeeded, yet claude auth status --json still reads logged in (api_key, from ANTHROPIC_API_KEY)",
      "kind": "failed",
      "reason": "still_logged_in",
    }
  `);
  // The stored login is gone all the same; the key is not claude's to remove.
  assert.equal(fake.read().loggedIn, false);
});

test("a failure in claude's words is rejected; one that still signed out is logged_out; a crash is redacted", async () => {
  const modes = ["fail", "fail_after_clear", "crash"];
  const results = await Promise.all(modes.map(async (logoutMode) => claudeLogout(installation(fakeClaude({ logoutMode })))));
  expect(results).toMatchInlineSnapshot(`
    [
      {
        "detail": "EACCES: permission denied, unlink '/home/user/.claude/.credentials.json'",
        "kind": "failed",
        "reason": "rejected",
      },
      {
        "kind": "logged_out",
      },
      {
        "detail": "TypeError: cannot read token [redacted]",
        "kind": "failed",
        "reason": "process_failed",
      },
    ]
  `);
});

test("a status that cannot tell leaves claude's own report: a logout that succeeded is logged_out, one that failed is its failure", async () => {
  const fake = fakeClaude({ statusBroken: true });
  assert.deepEqual(await claudeLogout(installation(fake)), { kind: "logged_out" });
  assert.equal(fake.read().loggedIn, false);
  const failing = fakeClaude({ statusBroken: true, logoutMode: "fail" });
  assert.deepEqual(await claudeLogout(installation(failing)), {
    kind: "failed",
    reason: "rejected",
    detail: "EACCES: permission denied, unlink '/home/user/.claude/.credentials.json'",
  });
});

test("past the deadline the logout is stopped with everything it started, and the status decides", async () => {
  const fake = fakeClaude({ logoutMode: "hang" });
  expect(await claudeLogout(installation(fake), { timeoutMs: 1000 })).toMatchInlineSnapshot(`
    {
      "detail": "claude auth logout did not finish within 1000 ms",
      "kind": "failed",
      "reason": "timed_out",
    }
  `);
  assert.ok(await gone(reportedPid(fake, "pid")), "claude auth logout outlived the deadline");
  assert.ok(await gone(reportedPid(fake, "workerPid")), "a process claude started outlived the deadline");
  // Logged out already: a logout that hangs still ends logged_out, since the status reads so.
  const signedOut = fakeClaude({ logoutMode: "hang", loggedIn: false });
  assert.deepEqual(await claudeLogout(installation(signedOut), { timeoutMs: 500 }), { kind: "logged_out" });
});

test("a claude without auth logout, an installation that is not an executable, or a missing one runs nothing", async () => {
  const fake = fakeClaude();
  const results = await Promise.all([
    claudeLogout(installation(fake, "2.1.40 (Claude Code)")),
    claudeLogout({ kind: "available", via: "bundled" }),
    claudeLogout({ kind: "available", via: "executable", command: "no-such-claude-for-oar-tests", version: "2.1.292" }),
  ]);
  expect(results).toMatchInlineSnapshot(`
    [
      {
        "detail": "claude 2.1.41 or later is required; this is 2.1.40",
        "kind": "unsupported",
        "reason": "version_unsupported",
      },
      {
        "detail": "not a machine-installed executable",
        "kind": "unsupported",
        "reason": "unsupported_installation",
      },
      {
        "detail": "claude executable not found: no-such-claude-for-oar-tests",
        "kind": "failed",
        "reason": "process_failed",
      },
    ]
  `);
  assert.equal(fake.read().logoutStarted, undefined);
});

test("a command that cannot be spawned fails at once", async () => {
  const result = await claudeLogout({ kind: "available", via: "executable", command: "invalid\0binary", version: "2.1.292" });
  assert.equal(result.kind === "failed" ? result.reason : result.kind, "process_failed");
});
