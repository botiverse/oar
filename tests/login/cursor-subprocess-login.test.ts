/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers describe IPC messages and failure details. */
import { ChildProcess } from "node:child_process";
import { expect, test, vi } from "vitest";
import { createCursorRuntime } from "../../packages/oar/src/index.js";
import { bundled, fakeCursorRuntime, tempDirectory } from "../fixtures/cursor-subprocess.js";
import { FAKE_KEY, FAKE_LOGIN_URL } from "../fixtures/fake-cursor-sdk-module.mjs";
import { recordedInteraction } from "../fixtures/login-interaction.js";

/*
 * In subprocess mode login, logout and the status each run in a one-shot
 * child with the call's `env`. The login runs in the child with a store that
 * asks the host whether it may save, then saves to the child's own
 * `FileCredentialStore`: the minted key never crosses IPC. Every IPC message
 * in both directions is recorded here through `ChildProcess.prototype`.
 */

/** Every IPC message, both ways, of the children spawned from now on; read after the calls. */
function tapIpc(): () => unknown[] {
  const received: unknown[] = [];
  const sends: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }[] = [];
  // oxlint-disable-next-line typescript/unbound-method, eslint/prefer-destructuring -- called below with the child as `this`.
  const emit = ChildProcess.prototype.emit;
  vi.spyOn(ChildProcess.prototype, "emit").mockImplementation(function tapped(this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === "message") { received.push(args[0]); }
    // Node gives each child with an IPC channel its own `send`: spy on it once the child exists.
    if (event === "spawn" && this.connected) { sends.push(vi.spyOn(this, "send")); }
    return emit.call(this, event, ...args);
  });
  return () => [...received, ...sends.flatMap((send) => send.mock.calls.map((call) => call[0]))];
}

// oxlint-disable-next-line eslint/max-statements -- one login, its status, and every IPC message, asserted together.
test("the login runs in a child with the call's env; its key is saved there and never crosses IPC or reaches a result", async () => {
  const tapped = tapIpc();
  const runtime = fakeCursorRuntime("subprocess");
  const env = { OAR_FAKE_CURSOR_HOME: tempDirectory() };
  const interaction = recordedInteraction([]);
  const result = await runtime.login(bundled, interaction, { env });
  const status = await runtime.authStatus(bundled, { env });
  const seen = tapped();
  vi.restoreAllMocks();
  expect(result).toEqual({ kind: "logged_in", account: { credential: "api_key", metering: "plan", email: "child@example.com" } });
  expect(interaction.events).toEqual([{ kind: "auth_url", url: FAKE_LOGIN_URL, instructions: "Open this URL on any device and sign in to Cursor; the login completes on its own." }]);
  // The child saved it to its own store: the next child's status reads it.
  expect(status).toMatchObject({ kind: "logged_in", account: { email: "child@example.com" } });
  // Both directions were seen, the save included.
  expect(seen).toEqual(expect.arrayContaining([
    expect.objectContaining({ t: "ready" }),
    expect.objectContaining({ m: "login" }),
    expect.objectContaining({ t: "event", v: { save: true } }),
    expect.objectContaining({ m: "commit" }),
  ]));
  expect(JSON.stringify({ seen, result, status, events: interaction.events })).not.toContain(FAKE_KEY);
});

test("a cancelled login writes nothing, and logout clears what a login saved", async () => {
  const runtime = fakeCursorRuntime("subprocess");
  const home = tempDirectory();
  const abort = new AbortController();
  const interaction = recordedInteraction([], { signal: abort.signal });
  const login = runtime.login(bundled, { ...interaction, onEvent(event) { interaction.onEvent(event); abort.abort(); } }, { env: { OAR_FAKE_CURSOR_HOME: home, OAR_FAKE_CURSOR_LOGIN: "hold" } });
  expect(await login).toEqual({ kind: "cancelled" });
  expect(await runtime.authStatus(bundled, { env: { OAR_FAKE_CURSOR_HOME: home } })).toMatchObject({ kind: "logged_out" });
  expect(await runtime.login(bundled, recordedInteraction([]), { env: { OAR_FAKE_CURSOR_HOME: home } })).toMatchObject({ kind: "logged_in" });
  expect(await runtime.logout(bundled, { env: { OAR_FAKE_CURSOR_HOME: home } })).toMatchObject({ kind: "logged_out" });
  expect(await runtime.authStatus(bundled, { env: { OAR_FAKE_CURSOR_HOME: home } })).toMatchObject({ kind: "logged_out" });
});

test("CURSOR_API_KEY is read from the call's env, not the host's", async () => {
  vi.stubEnv("CURSOR_API_KEY", undefined);
  const runtime = fakeCursorRuntime("subprocess");
  const env = { OAR_FAKE_CURSOR_HOME: tempDirectory(), CURSOR_API_KEY: "crsr_env_key_0123456789" };
  expect(await runtime.authStatus(bundled, { env })).toMatchObject({ kind: "unknown", configured: ["environment: CURSOR_API_KEY"] });
  const interaction = recordedInteraction([]);
  await runtime.login(bundled, interaction, { env });
  expect(interaction.events.map((event) => event.kind)).toEqual(["auth_url", "info"]);
  vi.unstubAllEnvs();
});

test("a module the child cannot load fails each call with the reason, and opens no session", async () => {
  const runtime = createCursorRuntime({ execution: "subprocess", sdkModule: new URL("missing-cursor-sdk.mjs", import.meta.url).href });
  const login = await runtime.login(bundled, recordedInteraction([]));
  expect(login).toMatchObject({ kind: "failed", reason: "process_failed", detail: expect.stringContaining("cursor could not load @cursor/sdk in its child process") });
  expect(await runtime.authStatus(bundled)).toMatchObject({ kind: "unknown", detail: expect.stringContaining("cursor could not load @cursor/sdk in its child process") });
  await expect(runtime.session(bundled, { cwd: tempDirectory() })).rejects.toThrow("cursor could not load @cursor/sdk in its child process");
  await expect(runtime.listModels(bundled)).rejects.toThrow("Failed to list Cursor models");
});
