import { afterEach, expect, test, vi } from "vitest";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { bundled, fakeCursorRuntime, lastResult, printEnvironment, printEnvironmentNames, tempDirectory } from "../fixtures/cursor-subprocess.js";

/*
 * Subprocess mode's reason to exist: the session's tools run with the
 * session's environment, not the host's. The fake SDK runs a shell command
 * as the SDK's shell tool does (execSync, inheriting its process's
 * environment), in the session's own child process.
 */

afterEach(() => { vi.unstubAllEnvs(); });

test("a host-only variable the session env removes is not visible to the agent's shell; a session-only one is", async () => {
  vi.stubEnv("OAR_TEST_DAEMON_ONLY", "daemon-only-value");
  vi.stubEnv("OAR_TEST_SESSION_ONLY", undefined);
  const runtime = fakeCursorRuntime("subprocess");
  const session = await runtime.session(bundled, {
    cwd: tempDirectory(),
    env: { OAR_TEST_DAEMON_ONLY: null, OAR_TEST_SESSION_ONLY: "session-only-value" },
  });
  try {
    const prompt = await session.prompt(`shell:${printEnvironment(["OAR_TEST_DAEMON_ONLY", "OAR_TEST_SESSION_ONLY"])}`);
    expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "completed" });
    expect(lastResult(session)).toBe(JSON.stringify([null, "session-only-value"]));
    // The host itself is unchanged.
    expect([process.env.OAR_TEST_DAEMON_ONLY, process.env.OAR_TEST_SESSION_ONLY]).toEqual(["daemon-only-value", undefined]);
  } finally {
    await session.dispose();
  }
});

/** Variables the shell itself sets (dash sets PWD; bash also SHLVL and _), not passed by anyone. */
const SHELL_SET: ReadonlySet<string> = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);
/** What OAR may add to a clean child: the SDK's native companion paths, when the SDK's companion package resolves. */
const OAR_ADDED: ReadonlySet<string> = new Set(["CURSOR_TREE_SITTER_VENDOR_DIR", "CURSOR_RIPGREP_PATH"]);

async function shellSees(envBase: "inherit" | "clean", env: Readonly<Record<string, string | null>>, command: string): Promise<unknown> {
  const session = await fakeCursorRuntime("subprocess", envBase).session(bundled, { cwd: tempDirectory(), env });
  try {
    const prompt = await session.prompt(`shell:${command}`);
    expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "completed" });
    const result = lastResult(session);
    return typeof result === "string" ? JSON.parse(result) : result;
  } finally {
    await session.dispose();
  }
}

test("envBase clean: the agent's shell sees only what the session passed, plus what OAR adds to run the SDK", async () => {
  vi.stubEnv("OAR_TEST_DAEMON_ONLY", "daemon-only-value");
  const seen = await shellSees("clean", { OAR_TEST_SESSION_ONLY: "session-only-value", OAR_TEST_DAEMON_ONLY: null }, printEnvironmentNames());
  expect(Array.isArray(seen)).toBe(true);
  const listed: unknown[] = Array.isArray(seen) ? seen : [];
  const names = listed.filter((name): name is string => typeof name === "string" && !SHELL_SET.has(name));
  expect(names.filter((name) => !OAR_ADDED.has(name))).toEqual(["OAR_TEST_SESSION_ONLY"]);
  // No PATH, HOME or Electron switch from the host, nor the variable that started the child as Node.
  expect(names).not.toContain("ELECTRON_RUN_AS_NODE");
});

test("a host-only variable the session does not remove is absent under envBase clean and present under inherit", async () => {
  vi.stubEnv("OAR_TEST_DAEMON_ONLY", "daemon-only-value");
  const command = printEnvironment(["OAR_TEST_DAEMON_ONLY", "OAR_TEST_SESSION_ONLY"]);
  const env = { OAR_TEST_SESSION_ONLY: "session-only-value" };
  expect(await shellSees("clean", env, command)).toEqual([null, "session-only-value"]);
  expect(await shellSees("inherit", env, command)).toEqual(["daemon-only-value", "session-only-value"]);
});

test("envBase clean applies to the one-shot children too: the status reads CURSOR_API_KEY from env alone", async () => {
  vi.stubEnv("CURSOR_API_KEY", "crsr_host_key_0123456789");
  const runtime = fakeCursorRuntime("subprocess", "clean");
  expect(await runtime.authStatus(bundled, { env: { OAR_FAKE_CURSOR_HOME: tempDirectory() } })).toMatchObject({ kind: "logged_out" });
  expect(await fakeCursorRuntime("subprocess").authStatus(bundled)).toMatchObject({ kind: "unknown", configured: ["environment: CURSOR_API_KEY"] });
  const listed = await runtime.listModels(bundled, { env: { CURSOR_API_KEY: "rejected-key-0123456789" } });
  expect(listed.kind).toBe("unauthenticated");
});

test("without an overlay the child inherits the host's environment, as a process runtime does", async () => {
  vi.stubEnv("OAR_TEST_DAEMON_ONLY", "daemon-only-value");
  const session = await fakeCursorRuntime("subprocess").session(bundled, { cwd: tempDirectory() });
  try {
    const prompt = await session.prompt(`shell:${printEnvironment(["OAR_TEST_DAEMON_ONLY"])}`);
    await awaitTurnEnd(session, prompt.seq);
    expect(lastResult(session)).toBe(JSON.stringify(["daemon-only-value"]));
  } finally {
    await session.dispose();
  }
});

test("a per-session CURSOR_API_KEY reaches the child and is redacted from the records", async () => {
  const key = "crsr_session_only_key_0123456789";
  const session = await fakeCursorRuntime("subprocess").session(bundled, { cwd: tempDirectory(), env: { CURSOR_API_KEY: key } });
  try {
    const prompt = await session.prompt(`shell:${printEnvironment(["CURSOR_API_KEY"])}`);
    await awaitTurnEnd(session, prompt.seq);
    expect(lastResult(session)).toBe(JSON.stringify(["[redacted]"]));
    expect(JSON.stringify(session.records())).not.toContain(key);
  } finally {
    await session.dispose();
  }
});

test("a key the SDK refuses at open crosses as its name and status, and is an auth failure", async () => {
  const runtime = fakeCursorRuntime("subprocess");
  await expect(runtime.session(bundled, { cwd: tempDirectory(), env: { CURSOR_API_KEY: "rejected-key-0123456789" } }))
    .rejects.toMatchObject({ name: "RuntimeFailureError", failure: "auth", credential: "rejected", status: 401 });
  expect(await runtime.listModels(bundled, { env: { CURSOR_API_KEY: "rejected-key-0123456789" } }))
    .toEqual({ kind: "unauthenticated", detail: "Invalid User API Key" });
});

test("the in-process mode still refuses env; the subprocess mode declares it accepted", () => {
  expect(fakeCursorRuntime("in_process").refusedSessionOptions.env).toBeDefined();
  expect(fakeCursorRuntime("subprocess").refusedSessionOptions.env).toBeUndefined();
});
