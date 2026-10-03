import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { codexAuthStatus, codexLogin } from "../../packages/oar/src/runtimes/codex/login.js";
import { fakeLoginCli, reportedPid, type FakeCli } from "../fixtures/login-fixtures.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";
import { gone } from "../fixtures/process-tree.js";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oar-codex-login-"));
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
    state: { version: "0.160.0", email: "user@example.com", loggedIn: false, mode: "success", ...state },
  });
}

function installation(fake: FakeCli, version = "codex-cli 0.160.0"): Parameters<typeof codexLogin>[0] {
  return { kind: "available", via: "executable", command: fake.command, version };
}

test("the device code and its URL are relayed, and account/read names the account", async () => {
  const fake = fakeCodex();
  const interaction = recordedInteraction([]);
  const result = await codexLogin(installation(fake), interaction);
  expect({ result, events: interaction.events }).toMatchInlineSnapshot(`
    {
      "events": [
        {
          "kind": "device_code",
          "userCode": "ABCD-EFGH",
          "verificationUri": "https://auth.openai.com/codex/device",
        },
        {
          "kind": "info",
          "message": "Device code sign-in must be allowed in your ChatGPT security settings (for a workspace account, by its admin).",
        },
      ],
      "result": {
        "account": {
          "email": "user@example.com",
          "method": "chatgpt",
          "plan": "plus",
        },
        "kind": "logged_in",
      },
    }
  `);
  assert.deepEqual(interaction.prompts, []);
  assert.deepEqual(fake.read().startParams, { type: "chatgptDeviceCode" });
  // Never `codex login`, which clears the stored sign-in before the new one completes.
  assert.deepEqual(fake.read().invocations, ["app-server --listen stdio://"]);
});

test("codex's own failure, a refused start, an app-server crash and an unconfirmed success are reported apart", async () => {
  const modes = ["failure", "start_error", "crash", "unverified"];
  const results = await Promise.all(modes.map(async (mode) => codexLogin(installation(fakeCodex({ mode })), recordedInteraction([]))));
  expect(results).toMatchInlineSnapshot(`
    [
      {
        "detail": "device code expired",
        "kind": "failed",
        "reason": "rejected",
      },
      {
        "detail": "device code login is not enabled for this workspace",
        "kind": "failed",
        "reason": "rejected",
      },
      {
        "detail": "codex app-server exited with code 3 before the sign-in completed",
        "kind": "failed",
        "reason": "process_failed",
      },
      {
        "detail": "codex reported success, yet account/read shows no account",
        "kind": "failed",
        "reason": "not_logged_in",
      },
    ]
  `);
});

test("the app-server's stderr reaches neither the host's stderr nor the result", async () => {
  vi.stubEnv("OAR_CHILD_STDERR", "inherit");
  const write = vi.spyOn(process.stderr, "write");
  try {
    const result = await codexLogin(installation(fakeCodex({ mode: "crash" })), recordedInteraction([]));
    assert.ok(!JSON.stringify(result).includes("panicked"), JSON.stringify(result));
    const forwarded = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    assert.ok(!forwarded.includes("panicked"), forwarded);
  } finally {
    write.mockRestore();
    vi.unstubAllEnvs();
  }
});

test("once codex reports success the login stands: an account/read that fails, a completion before the start reply", async () => {
  const results = await Promise.all(["read_error", "early"].map(async (mode) => codexLogin(installation(fakeCodex({ mode })), recordedInteraction([]))));
  expect(results).toMatchInlineSnapshot(`
    [
      {
        "kind": "logged_in",
      },
      {
        "account": {
          "email": "user@example.com",
          "method": "chatgpt",
          "plan": "plus",
        },
        "kind": "logged_in",
      },
    ]
  `);
});

test("a deadline after codex reported success is not a timeout: account/read still names the account", async () => {
  const result = await codexLogin(installation(fakeCodex({ readDelayMs: 1500 })), recordedInteraction([]), { timeoutMs: 1000 });
  expect(result).toMatchInlineSnapshot(`
    {
      "account": {
        "email": "user@example.com",
        "method": "chatgpt",
        "plan": "plus",
      },
      "kind": "logged_in",
    }
  `);
});

test("an abort after codex reported success is not a cancel, and stops waiting for account/read", async () => {
  const abort = new AbortController();
  const interaction = recordedInteraction([], { signal: abort.signal });
  const result = await codexLogin(installation(fakeCodex({ readDelayMs: 60_000 })), {
    ...interaction,
    onEvent(event) {
      interaction.onEvent(event);
      setTimeout(() => {
        abort.abort();
      }, 500);
    },
  });
  assert.deepEqual(result, { kind: "logged_in" });
});

test("a command that cannot be spawned fails at once", async () => {
  const result = await codexLogin({ kind: "available", via: "executable", command: "invalid\0binary", version: "codex-cli 0.160.0" }, recordedInteraction([]));
  assert.equal(result.kind === "failed" ? result.reason : result.kind, "process_failed");
});

test("past the deadline the app-server is stopped with everything it started", async () => {
  const fake = fakeCodex({ mode: "hang" });
  const result = await codexLogin(installation(fake), recordedInteraction([]), { timeoutMs: 1000 });
  assert.deepEqual(result, { kind: "failed", reason: "timed_out", detail: "no sign-in within 1000 ms" });
  assert.ok(await gone(reportedPid(fake, "pid")), "the app-server outlived the deadline");
  assert.ok(await gone(reportedPid(fake, "workerPid")), "a process the app-server started outlived the deadline");
});

test("aborting the signal cancels the login and stops the app-server's process group (its tree on Windows)", async () => {
  const fake = fakeCodex({ mode: "hang" });
  const abort = new AbortController();
  const interaction = recordedInteraction([], { signal: abort.signal });
  const result = await codexLogin(installation(fake), {
    ...interaction,
    onEvent(event) {
      interaction.onEvent(event);
      abort.abort();
    },
  });
  assert.deepEqual(result, { kind: "cancelled" });
  assert.ok(await gone(reportedPid(fake, "workerPid")), "a process the app-server started outlived the cancel");
});

test("a codex without the device code login starts nothing", async () => {
  const fake = fakeCodex();
  expect(await codexLogin(installation(fake, "codex-cli 0.117.0"), recordedInteraction([]))).toMatchInlineSnapshot(`
    {
      "detail": "codex 0.118.0 or later is required; this is 0.117.0",
      "kind": "unsupported",
      "reason": "version_unsupported",
    }
  `);
  assert.equal(fake.read().invocations, undefined);
});

test("auth status reads codex login status", async () => {
  const states = [{ loggedIn: true }, { loggedIn: false }, { status: "broken" }];
  const statuses = await Promise.all(states.map(async (state) => codexAuthStatus(installation(fakeCodex(state)))));
  expect(statuses).toMatchInlineSnapshot(`
    [
      {
        "account": {
          "method": "chatgpt",
        },
        "kind": "logged_in",
        "source": "codex login status",
      },
      {
        "kind": "logged_out",
        "source": "codex login status",
      },
      {
        "detail": "Error loading configuration: invalid TOML",
        "kind": "unknown",
        "source": "codex login status",
      },
    ]
  `);
});
