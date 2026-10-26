import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { claudeRuntime } from "../../packages/oar/src/runtimes/claude/index.js";
import { codexRuntime } from "../../packages/oar/src/runtimes/codex/index.js";
import { qoderRuntime } from "../../packages/oar/src/runtimes/qoder/index.js";
import { fakeLoginCli } from "../fixtures/login-fixtures.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }); }));
});

const cases = [
  [claudeRuntime, "fake-claude-login.mjs", "2.1.309", 5],
  [codexRuntime, "fake-codex-login.mjs", "0.164.0", 4],
  [qoderRuntime, "fake-qoder-login.mjs", "1.1.78", 3],
] as const;

// oxlint-disable-next-line max-statements -- One login and logout with their confirmation reads form one isolation regression.
test.each(cases.map(([runtime, script, version, captures]) => ({ runtime, script, version, captures })))("$runtime.id uses the caller environment for login, confirmation, status and logout", async ({ runtime, script, version, captures }) => {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-auth-env-")); directories.push(dir);
  const code = "synthetic-authorization#state";
  const captureEnv = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HTTP_PROXY", "OAR_ENV_REMOVED", "OAR_ENV_INHERITED", "BROWSER", "CLAUDECODE"];
  vi.stubEnv("OAR_ENV_REMOVED", "parent-only");
  vi.stubEnv("OAR_ENV_INHERITED", "inherited-value");
  const before = { ...process.env };
  const fake = fakeLoginCli({ dir, name: `auth-${runtime.id}`, script, state: { code, version, mode: "success", loggedIn: false, captureEnv } });
  const installation = { kind: "available", via: "executable", command: fake.command, version } as const;
  const env = {
    HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, "claude"), CODEX_HOME: path.join(dir, "codex"),
    HTTP_PROXY: "http://synthetic:password@example.invalid", OAR_ENV_REMOVED: null, BROWSER: "caller-browser",
    CLAUDECODE: "caller-marker",
  };
  const login = await runtime.login(installation, recordedInteraction([code]), { env, openBrowser: false });
  const status = await runtime.authStatus(installation, { env });
  expect(login.kind).toBe("logged_in"); expect(status.kind).toBe("logged_in");
  if ("logout" in runtime) { const logout = await runtime.logout(installation, { env }); expect(logout.kind).toBe("logged_out"); }
  const { environments } = fake.read();
  assert.ok(Array.isArray(environments));
  const expected = { ...env, OAR_ENV_INHERITED: "inherited-value" };
  expect(environments.length).toBe(captures);
  for (const row of environments) { assertCapturedEnvironment(row, runtime.id, expected); }
  expect(process.env).toEqual(before);
});

test("login preflight resolves a bare executable using the child PATH", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-auth-path-")); directories.push(dir);
  const name = `qoder-${path.basename(dir)}`;
  fakeLoginCli({ dir, name, script: "fake-qoder-login.mjs", state: { mode: "success", loggedIn: false } });
  const installation = { kind: "available", via: "executable", command: name, version: "1.1.78" } as const;
  const result = await qoderRuntime.login(installation, recordedInteraction([]), { env: { PATH: dir }, openBrowser: false });
  expect(result.kind).toBe("logged_in");
});

test.each(["", null])("login preflight does not restore the host PATH when the caller sets %s", async (value) => {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-auth-empty-path-")); directories.push(dir);
  const name = `qoder-${path.basename(dir)}`;
  const fake = fakeLoginCli({ dir, name, script: "fake-qoder-login.mjs", state: { mode: "success", loggedIn: false } });
  vi.stubEnv("PATH", dir);
  const result = await qoderRuntime.login({ kind: "available", via: "executable", command: name }, recordedInteraction([]), { env: { PATH: value } });
  expect(result.kind).toBe("failed");
  expect(fake.read().loggedIn).toBe(false);
});

function assertCapturedEnvironment(row: unknown, runtime: string, expected: Record<string, unknown>): void {
  assert.ok(typeof row === "object" && row !== null && "args" in row && "environment" in row);
  assert.ok(Array.isArray(row.args));
  const login = row.args.includes("login") && !row.args.includes("status");
  let browser = "caller-browser";
  if (login && runtime === "claude") { browser = process.platform === "win32" ? path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "hostname.exe") : "true"; }
  if (login && runtime === "qoder") { browser = "www-browser"; }
  expect(row.environment).toEqual({ ...expected, BROWSER: browser, CLAUDECODE: runtime === "claude" ? null : "caller-marker" });
}

// oxlint-disable-next-line max-statements -- Keep the cwd executable and login preflight regression together.
test("an explicitly empty PATH cannot execute a same-named file in cwd", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-auth-cwd-")); directories.push(dir);
  const name = `qoder-${path.basename(dir)}`;
  const fake = fakeLoginCli({ dir, name, script: "fake-qoder-login.mjs", state: { mode: "success", loggedIn: false } });
  const local = path.join(process.cwd(), path.basename(fake.command));
  await copyFile(fake.command, local);
  try {
    const result = await qoderRuntime.login({ kind: "available", via: "executable", command: name }, recordedInteraction([]), { env: { PATH: "" } });
    expect(result.kind).toBe("failed");
    expect(fake.read().loggedIn).toBe(false);
  } finally { await rm(local, { force: true }); }
});
