import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { createCursorRuntime } from "../../packages/oar/src/index.js";
import { bundled, FakeCursor, leaks, PREVIOUS, REFUSED, startLogin, unused } from "../fixtures/fake-cursor-auth.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";

test("the URL reaches the host through onLoginUrl only, and the stored login's status names the account", async () => {
  const fake = new FakeCursor({ stored: PREVIOUS }).signIn().mint();
  const interaction = recordedInteraction([]);
  const result = await fake.runtime().login(bundled, interaction);
  expect({ result, events: interaction.events }).toMatchInlineSnapshot(`
    {
      "events": [
        {
          "instructions": "Open this URL on any device and sign in to Cursor; the login completes on its own.",
          "kind": "auth_url",
          "url": "https://cursor.com/loginDeepControl?challenge=Q2hhbGxlbmdl&uuid=0b5c7a52-2a39-4c55-9a3e-1f0e8e1f3a11&mode=login&redirectTarget=sdk",
        },
      ],
      "result": {
        "account": {
          "email": "user@example.com",
          "expiresAt": "2027-01-04T12:00:00.000Z",
        },
        "kind": "logged_in",
      },
    }
  `);
  // No browser of the SDK's own and no paste-back prompt: the SDK polls. The key went to its own store once, and nowhere else.
  assert.deepEqual([fake.logins[0]?.openBrowser, interaction.prompts, fake.writes.length], [false, [], 1]);
  assert.equal(await fake.sdkOutcome.promise, "resolved");
  assert.ok(!leaks({ result, events: interaction.events }));
});

test("a cancel while the SDK waits for the browser stops its poll and writes nothing", async () => {
  const fake = new FakeCursor({ stored: PREVIOUS });
  const { login, abort } = await startLogin(fake);
  abort.abort();
  assert.deepEqual(await login, { kind: "cancelled" });
  assert.equal(fake.logins[0]?.signal.aborted, true);
  assert.equal(await fake.sdkOutcome.promise, "Login was cancelled.");
  assert.deepEqual(fake.writes, []);
});

test("a cancel after the browser sign-in, while the SDK mints its key (it ignores the signal), refuses the SDK's late save", async () => {
  const fake = new FakeCursor({ stored: PREVIOUS }).signIn();
  const { login, abort } = await startLogin(fake);
  abort.abort();
  assert.deepEqual(await login, { kind: "cancelled" });
  // The minting finishes after the cancel, and the SDK tries to save its key.
  fake.mint();
  assert.equal(await fake.sdkOutcome.promise, REFUSED);
  assert.deepEqual(fake.writes, []);
  // The previous login is as it was.
  expect(await fake.runtime().authStatus(bundled)).toMatchInlineSnapshot(`
    {
      "account": {
        "email": "previous@example.com",
        "expiresAt": "2026-12-01T00:00:00.000Z",
      },
      "kind": "logged_in",
      "source": "Cursor.auth.status",
    }
  `);
});

test("the deadline is timed_out, stops the SDK's poll, and a save after it is refused", async () => {
  const waiting = new FakeCursor();
  const minting = new FakeCursor().signIn();
  const results = await Promise.all([waiting, minting].map(async (fake) => fake.runtime().login(bundled, recordedInteraction([]), { timeoutMs: 20 })));
  expect(results).toMatchInlineSnapshot(`
    [
      {
        "detail": "no sign-in within 20 ms",
        "kind": "failed",
        "reason": "timed_out",
      },
      {
        "detail": "no sign-in within 20 ms",
        "kind": "failed",
        "reason": "timed_out",
      },
    ]
  `);
  assert.deepEqual([waiting.logins[0]?.signal.aborted, minting.logins[0]?.signal.aborted], [true, true]);
  minting.mint();
  assert.deepEqual(await Promise.all([waiting.sdkOutcome.promise, minting.sdkOutcome.promise]), ["Login was cancelled.", REFUSED]);
  assert.deepEqual([waiting.writes, minting.writes], [[], []]);
});

// oxlint-disable-next-line eslint/max-statements -- both stops, each while the SDK's save is held, in one run.
test("once the SDK is saving its key, a cancel or a deadline does not undo the login: the status decides", async () => {
  const cancelled = new FakeCursor().signIn().mint();
  const late = new FakeCursor().signIn().mint();
  const releases = [cancelled.holdSave(), late.holdSave()];
  const abort = new AbortController();
  const logins = [
    cancelled.runtime().login(bundled, recordedInteraction([], { signal: abort.signal })),
    late.runtime().login(bundled, recordedInteraction([]), { timeoutMs: 20 }),
  ];
  await vi.waitFor(() => {
    assert.deepEqual([cancelled.saving, late.saving], [true, true]);
  });
  abort.abort();
  // Past the 20 ms deadline while both saves are held.
  await sleep(60);
  for (const release of releases) {
    release();
  }
  // After an abort the status is not asked: logged in, without an account.
  expect(await Promise.all(logins)).toMatchInlineSnapshot(`
    [
      {
        "kind": "logged_in",
      },
      {
        "account": {
          "email": "user@example.com",
          "expiresAt": "2027-01-04T12:00:00.000Z",
        },
        "kind": "logged_in",
      },
    ]
  `);
  assert.deepEqual([cancelled.writes.length, late.writes.length], [1, 1]);
});

test("the SDK's own failure is rejected in its words, with token shapes redacted", async () => {
  const fakes = [
    new FakeCursor().signIn(new Error("Login failed or timed out. Please try again.")),
    new FakeCursor().signIn().mint(new Error("Login succeeded, but creating an SDK API key failed: token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl rejected (ask a team admin)\nstack line")),
    new FakeCursor({ saveError: new Error("EACCES: permission denied, open '/home/user/.cursor/sdk/auth.json'") }).signIn().mint(),
  ];
  const results = await Promise.all(fakes.map(async (fake) => fake.runtime().login(bundled, recordedInteraction([]))));
  expect(results).toMatchInlineSnapshot(`
    [
      {
        "detail": "Login failed or timed out. Please try again.",
        "kind": "failed",
        "reason": "rejected",
      },
      {
        "detail": "Login succeeded, but creating an SDK API key failed: token [redacted] rejected (ask a team admin)",
        "kind": "failed",
        "reason": "rejected",
      },
      {
        "detail": "EACCES: permission denied, open '/home/user/.cursor/sdk/auth.json'",
        "kind": "failed",
        "reason": "rejected",
      },
    ]
  `);
  assert.deepEqual(fakes.map((fake) => fake.writes), [[], [], []]);
});

test("a saved key the status does not confirm is not_logged_in; a status that fails leaves logged_in without an account", async () => {
  const fakes = [
    new FakeCursor({ afterSave: { status: "logged-out" } }).signIn().mint(),
    new FakeCursor({ afterSave: new Error("EIO: i/o error, read") }).signIn().mint(),
  ];
  const results = await Promise.all(fakes.map(async (fake) => fake.runtime().login(bundled, recordedInteraction([]))));
  expect(results).toMatchInlineSnapshot(`
    [
      {
        "detail": "Cursor.auth.login stored a key, yet Cursor.auth.status says logged out",
        "kind": "failed",
        "reason": "not_logged_in",
      },
      {
        "kind": "logged_in",
      },
    ]
  `);
});

test("a caller that cannot show the URL ends the login before anything is written", async () => {
  const fake = new FakeCursor();
  const result = await fake.runtime().login(bundled, {
    ...recordedInteraction([]),
    onEvent() {
      throw new Error("no screen");
    },
  });
  assert.deepEqual(result, { kind: "failed", reason: "interaction_failed", detail: "no screen" });
  assert.equal(fake.logins[0]?.signal.aborted, true);
  assert.equal(await fake.sdkOutcome.promise, "Login was cancelled.");
  assert.deepEqual(fake.writes, []);
});

test("CURSOR_API_KEY in the environment is named in an info event, its value never read", async () => {
  vi.stubEnv("CURSOR_API_KEY", "crsr_env_key_value_0123456789");
  try {
    const interaction = recordedInteraction([]);
    const result = await new FakeCursor().signIn().mint().runtime().login(bundled, interaction);
    assert.equal(result.kind, "logged_in");
    expect(interaction.events.map((event) => event.kind === "info" ? event.message : event.kind)).toMatchInlineSnapshot(`
      [
        "auth_url",
        "CURSOR_API_KEY is set in this environment: cursor uses it, not the stored login, until it is unset.",
      ]
    `);
    assert.ok(!JSON.stringify(interaction.events).includes("crsr_env_key_value"));
  } finally {
    vi.unstubAllEnvs();
  }
});

test("nothing runs for an aborted signal; another installation, an SDK without Cursor.auth, or a failed load ends the login at once", async () => {
  const fake = new FakeCursor();
  const aborted = recordedInteraction([], { signal: AbortSignal.abort() });
  const results = await Promise.all([
    fake.runtime().login(bundled, aborted),
    fake.runtime().login({ kind: "available", via: "executable", command: "cursor-agent" }, recordedInteraction([])),
    createCursorRuntime({ sdk: async () => ({ Agent: fake.sdk.Agent, Cursor: { models: { list: unused } } }) }).login(bundled, recordedInteraction([])),
    createCursorRuntime({
      sdk: async () => {
        throw new Error("Cannot find package '@cursor/sdk'");
      },
    }).login(bundled, recordedInteraction([])),
  ]);
  expect(results).toMatchInlineSnapshot(`
    [
      {
        "kind": "cancelled",
      },
      {
        "detail": "cursor signs in through the bundled @cursor/sdk",
        "kind": "unsupported",
        "reason": "unsupported_installation",
      },
      {
        "detail": "@cursor/sdk 1.0.35 is required; this one has no Cursor.auth",
        "kind": "unsupported",
        "reason": "version_unsupported",
      },
      {
        "detail": "cursor could not load @cursor/sdk through the host's sdk loader",
        "kind": "failed",
        "reason": "process_failed",
      },
    ]
  `);
  assert.deepEqual([fake.loads, fake.logins.length], [0, 0]);
});
