import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { claudeAuthStatus } from "../../packages/oar/src/runtimes/claude/auth-status.js";
import { claudeLogin } from "../../packages/oar/src/runtimes/claude/login.js";
import { fakeLoginCli, reportedPid, type FakeCli } from "../fixtures/login-fixtures.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";
import { gone } from "../fixtures/process-tree.js";

const CODE = "fixture-authorization-code#fixture-state";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oar-claude-login-"));
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
    state: { version: "2.1.288", code: CODE, email: "user@example.com", loggedIn: false, mode: "paste", ...state },
  });
}

function installation(fake: FakeCli, version = "2.1.288 (Claude Code)"): Parameters<typeof claudeLogin>[0] {
  return { kind: "available", via: "executable", command: fake.command, version };
}

/** The pasted value and its authorization code never show; its state is already in the sign-in URL. */
function leaksNothing(code: string, ...values: unknown[]): void {
  for (const part of [code, code.split("#")[0] ?? code]) {
    for (const value of values) {
      assert.ok(!JSON.stringify(value).includes(part), `"${part}" leaked into ${JSON.stringify(value)}`);
    }
  }
}

test("the URL is relayed without its escapes, the pasted code goes to stdin only, and the status names the account", async () => {
  const fake = fakeClaude();
  const interaction = recordedInteraction([CODE]);
  const result = await claudeLogin(installation(fake), interaction);
  expect({ result, events: interaction.events, prompts: interaction.prompts }).toMatchInlineSnapshot(`
    {
      "events": [
        {
          "instructions": "Open this URL and sign in; if the page then shows a code, paste it back.",
          "kind": "auth_url",
          "url": "https://claude.com/cai/oauth/authorize?code=true&client_id=fixture&state=fixture-state",
        },
      ],
      "prompts": [
        {
          "kind": "manual_code",
          "message": "Paste the code shown after signing in",
          "placeholder": "code#state",
        },
      ],
      "result": {
        "account": {
          "email": "user@example.com",
          "method": "claude.ai",
          "plan": "pro",
        },
        "kind": "logged_in",
      },
    }
  `);
  assert.deepEqual(fake.read().received, [CODE]);
  assert.equal(fake.read().sawClaudeCode, false);
  leaksNothing(CODE, interaction.events, interaction.prompts, result);
});

test("an invalid code asks again, and the next code signs in", async () => {
  const fake = fakeClaude();
  const interaction = recordedInteraction(["fixture-code-without-state", ` ${CODE}\n`]);
  const result = await claudeLogin(installation(fake), interaction);
  assert.equal(result.kind, "logged_in");
  assert.deepEqual(interaction.prompts.map((prompt) => prompt.message), [
    "Paste the code shown after signing in",
    "That code was not accepted. Paste the full code shown after signing in",
  ]);
  assert.deepEqual(fake.read().received, ["fixture-code-without-state", CODE]);
  leaksNothing(CODE, interaction.events, interaction.prompts, result);
  leaksNothing("fixture-code-without-state", interaction.events, interaction.prompts, result);
});

test("a failed exchange is rejected in claude's words with the pasted code redacted", async () => {
  const fake = fakeClaude({ mode: "reject" });
  const interaction = recordedInteraction([CODE]);
  const result = await claudeLogin(installation(fake), interaction);
  expect(result).toMatchInlineSnapshot(`
    {
      "detail": "invalid_grant for code [redacted]",
      "kind": "failed",
      "reason": "rejected",
    }
  `);
  leaksNothing(CODE, interaction.events, result);
});

test("a sign-in finished in the browser ends the login while the paste prompt is still open", async () => {
  const fake = fakeClaude({ mode: "browser" });
  const interaction = recordedInteraction(["never"]);
  const result = await claudeLogin(installation(fake), interaction);
  assert.equal(result.kind, "logged_in");
  assert.deepEqual(fake.read().received, []);
});

test("success that claude's own status does not confirm is not a login", async () => {
  const fake = fakeClaude({ mode: "unverified" });
  const result = await claudeLogin(installation(fake), recordedInteraction([CODE]));
  expect(result).toMatchInlineSnapshot(`
    {
      "detail": "claude auth login reported success, yet claude auth status says logged out",
      "kind": "failed",
      "reason": "not_logged_in",
    }
  `);
});

test("a failure in claude's own words is reported in them, and `Login failed: Invalid code ...` asks nothing more", async () => {
  const ownWords = recordedInteraction([CODE]);
  const verifier = recordedInteraction([CODE]);
  const results = [
    await claudeLogin(installation(fakeClaude({ mode: "own_words" })), ownWords),
    await claudeLogin(installation(fakeClaude({ mode: "verifier" })), verifier),
  ];
  expect(results).toMatchInlineSnapshot(`
    [
      {
        "detail": "This organization does not allow logging in to Claude Code.",
        "kind": "failed",
        "reason": "rejected",
      },
      {
        "detail": "Invalid code verifier",
        "kind": "failed",
        "reason": "rejected",
      },
    ]
  `);
  assert.equal(ownWords.prompts.length, 1);
  assert.equal(verifier.prompts.length, 1);
});

test("a deadline after `Login successful.` is not a timeout: the stored login is confirmed by the status", async () => {
  const fake = fakeClaude({ mode: "linger" });
  const result = await claudeLogin(installation(fake), recordedInteraction([CODE]), { timeoutMs: 1500 });
  expect(result).toMatchInlineSnapshot(`
    {
      "account": {
        "email": "user@example.com",
        "method": "claude.ai",
        "plan": "pro",
      },
      "kind": "logged_in",
    }
  `);
  assert.ok(await gone(reportedPid(fake, "pid")), "claude auth login outlived the deadline");
});

test("an abort after `Login successful.` is not a cancel: the login is stored, with no status query left to ask", async () => {
  const fake = fakeClaude({ mode: "linger" });
  const abort = new AbortController();
  const interaction = recordedInteraction([CODE], {
    signal: abort.signal,
    onPrompt: () => {
      setTimeout(() => {
        abort.abort();
      }, 1000);
    },
  });
  const result = await claudeLogin(installation(fake), interaction);
  assert.deepEqual(result, { kind: "logged_in" });
});

test("a claude that is no longer there fails before anything is spawned, alike on every platform", async () => {
  // The probe's own lookup decides (a pinned path must exist, a bare name must be on PATH), not a spawn.
  const pinned = path.join(dir, "removed", "claude");
  const results = await Promise.all([pinned, "no-such-claude-for-oar-tests"].map(async (command) =>
    claudeLogin({ kind: "available", via: "executable", command, version: "2.1.288 (Claude Code)" }, recordedInteraction([]))));
  assert.deepEqual(results, [
    { kind: "failed", reason: "process_failed", detail: `claude executable not found: ${pinned}` },
    { kind: "failed", reason: "process_failed", detail: "claude executable not found: no-such-claude-for-oar-tests" },
  ]);
});

test("a command that cannot be spawned fails at once", async () => {
  const result = await claudeLogin({ kind: "available", via: "executable", command: "invalid\0binary", version: "2.1.288" }, recordedInteraction([]));
  assert.equal(result.kind === "failed" ? result.reason : result.kind, "process_failed");
});

test("past the deadline the login is stopped with everything it started", async () => {
  const fake = fakeClaude({ mode: "hang" });
  const result = await claudeLogin(installation(fake), recordedInteraction(["never"]), { timeoutMs: 1000 });
  expect(result).toMatchInlineSnapshot(`
    {
      "detail": "no sign-in within 1000 ms",
      "kind": "failed",
      "reason": "timed_out",
    }
  `);
  assert.ok(await gone(reportedPid(fake, "pid")), "claude auth login outlived the deadline");
  assert.ok(await gone(reportedPid(fake, "workerPid")), "a process claude started outlived the deadline");
});

test("aborting the signal cancels the login and stops its process group (its tree on Windows)", async () => {
  const fake = fakeClaude({ mode: "hang" });
  const abort = new AbortController();
  const interaction = recordedInteraction(["never"], {
    signal: abort.signal,
    onPrompt: () => {
      abort.abort();
    },
  });
  const result = await claudeLogin(installation(fake), interaction);
  assert.deepEqual(result, { kind: "cancelled" });
  assert.ok(await gone(reportedPid(fake, "workerPid")), "a process claude started outlived the cancel");
});

test("a prompt or an event handler that throws stops the login", async () => {
  const result = await claudeLogin(installation(fakeClaude()), recordedInteraction([new Error("terminal closed")]));
  assert.deepEqual(result, { kind: "failed", reason: "interaction_failed", detail: "terminal closed" });
  const throwing = recordedInteraction([CODE]);
  const fake = fakeClaude();
  const thrown = await claudeLogin(installation(fake), {
    ...throwing,
    onEvent() {
      throw new Error("no browser to show the URL in");
    },
  });
  assert.deepEqual(thrown, { kind: "failed", reason: "interaction_failed", detail: "no browser to show the URL in" });
  assert.equal(fake.read().loggedIn, false);
});

test("a claude that cannot read a pasted code, or an aborted signal, starts nothing", async () => {
  const fake = fakeClaude();
  expect(await claudeLogin(installation(fake, "2.1.100 (Claude Code)"), recordedInteraction([]))).toMatchInlineSnapshot(`
    {
      "detail": "claude 2.1.126 or later is required; this is 2.1.100",
      "kind": "unsupported",
      "reason": "version_unsupported",
    }
  `);
  const abort = new AbortController();
  abort.abort();
  assert.deepEqual(await claudeLogin(installation(fake), recordedInteraction([], { signal: abort.signal })), { kind: "cancelled" });
  assert.equal(fake.read().loginStarted, undefined);
});

test("auth status reads claude auth status --json", async () => {
  const states = [{ loggedIn: true }, { loggedIn: false }, { statusBroken: true }];
  const statuses = await Promise.all(states.map(async (state) => claudeAuthStatus(installation(fakeClaude(state)))));
  expect(statuses).toMatchInlineSnapshot(`
    [
      {
        "account": {
          "email": "user@example.com",
          "method": "claude.ai",
          "plan": "pro",
        },
        "kind": "logged_in",
        "source": "claude auth status --json",
      },
      {
        "kind": "logged_out",
        "source": "claude auth status --json",
      },
      {
        "detail": "claude auth status ended without an answer (exit 2)",
        "kind": "unknown",
        "source": "claude auth status --json",
      },
    ]
  `);
});
