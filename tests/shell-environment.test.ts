import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { writeShellEnvironmentCapture } from "../packages/oar/src/index.js";
import { UserShellEnvironmentError } from "../packages/oar/src/contracts/shell-environment.js";
import { parseShellEnvironment, shellEnvironmentCommand, userShellEnvironment } from "../packages/oar/src/shared/shell-environment.js";

const isSea = vi.hoisted(() => vi.fn(() => false));
vi.mock("node:sea", () => ({ isSea }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<{ spawn: typeof spawn }>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); isSea.mockReturnValue(false);
  await Promise.all(directories.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }); }));
});

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-shell-env-")); directories.push(dir);
  vi.stubEnv("HOME", dir); vi.stubEnv("ZDOTDIR", dir);
  return dir;
}

async function fakeShell(source: string): Promise<void> {
  const dir = await home();
  const command = path.join(dir, "fake-shell");
  await writeFile(command, `#!/bin/sh\n${source}\n`);
  await chmod(command, 0o755);
  vi.stubEnv("SHELL", command);
}

test("Windows is explicitly unsupported without trying to execute SHELL", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  await expect(userShellEnvironment()).rejects.toMatchObject({ name: "UserShellEnvironmentError", reason: "unsupported_platform" });
});

test.each(["sea", "compiled-bun", "old-bun"])("%s cannot reenter the host executable through a shell", async (host) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.stubEnv("SHELL", "/bin/bash");
  if (host === "sea") { isSea.mockReturnValue(true); }
  else { vi.stubGlobal("Bun", host === "compiled-bun" ? { isStandaloneExecutable: true } : {}); }
  vi.mocked(spawn).mockClear();
  await expect(userShellEnvironment()).rejects.toMatchObject({ reason: "no_node_runtime" });
  expect(spawn).not.toHaveBeenCalled();
});

// oxlint-disable-next-line max-lines-per-function -- Native subprocess cases share one platform gate.
describe.skipIf(process.platform === "win32")("private login shell capture", () => {
  // oxlint-disable-next-line max-statements -- Keep the complete capture and host isolation assertions together.
  test("reads a login profile, tolerates chatter, carries removals and reports only critical names", async () => {
    const dir = await home();
    vi.stubEnv("SHELL", "/bin/bash");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "inherited-directory");
    vi.stubEnv("HTTP_PROXY", "inherited-proxy");
    vi.stubEnv("OAR_SHELL_REMOVED", "parent-value");
    vi.stubEnv("ELECTRON_RUN_AS_NODE", undefined);
    const profile = `printf 'profile chatter\\n'\nexport CLAUDE_CONFIG_DIR='shell-directory'\nexport HTTP_PROXY='http://synthetic:password@example.invalid'\nexport OAR_SHELL_SECRET='synthetic-secret'\nunset OAR_SHELL_REMOVED\n`;
    await writeFile(path.join(dir, ".bash_profile"), profile);
    const inherited = { ...process.env };
    const result = await userShellEnvironment();
    expect(result.env.CLAUDE_CONFIG_DIR).toBe("shell-directory");
    expect(result.env.HTTP_PROXY).toBe("http://synthetic:password@example.invalid");
    expect(result.env.OAR_SHELL_REMOVED).toBeNull();
    expect(result.env.OAR_SHELL_SECRET).toBe("synthetic-secret");
    expect(result.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(result.changedVariables).toContain("CLAUDE_CONFIG_DIR");
    expect(result.changedVariables).toContain("HTTP_PROXY");
    expect(result.changedVariables).not.toContain("OAR_SHELL_SECRET");
    expect(result.changedVariables.every((name) => /^[A-Za-z_]+$/u.test(name))).toBe(true);
    expect(process.env).toEqual(inherited);
    // No global caching: a subsequent explicit read observes new startup configuration.
    await writeFile(path.join(dir, ".bash_profile"), "export CLAUDE_CONFIG_DIR=changed-again\n");
    const again = await userShellEnvironment();
    expect(again.env.CLAUDE_CONFIG_DIR).toBe("changed-again");
  });

  test("missing SHELL and a non-executable shell give separate typed failures", async () => {
    vi.stubEnv("SHELL", undefined);
    await expect(userShellEnvironment()).rejects.toMatchObject({ reason: "shell_not_set" });
    vi.stubEnv("SHELL", path.join(await home(), "absent"));
    await expect(userShellEnvironment()).rejects.toMatchObject({ reason: "shell_unavailable" });
    const file = path.join(process.env.HOME ?? "", "not-executable");
    await writeFile(file, "exit 0\n"); vi.stubEnv("SHELL", file);
    await expect(userShellEnvironment()).rejects.toMatchObject({ reason: "shell_unavailable" });
  });

  // oxlint-disable-next-line max-statements -- Observe both host streams around the complete failure boundary.
  test("a failed shell never returns its output as an error or a partial environment", async () => {
    await fakeShell(String.raw`printf 'synthetic-private-value\n'; printf 'synthetic-stderr-secret\n' >&2; exit 7`);
    vi.stubEnv("OAR_CHILD_STDERR", "inherit");
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    const failure: unknown = await userShellEnvironment().catch((error: unknown) => error);
    const outputCalls = stdout.mock.calls.length + stderr.mock.calls.length;
    stdout.mockRestore(); stderr.mockRestore();
    expect(outputCalls).toBe(0);
    assert.ok(failure instanceof UserShellEnvironmentError);
    expect(failure.reason).toBe("shell_failed");
    expect(JSON.stringify(failure)).not.toContain("synthetic");
    expect(String(failure)).not.toContain("synthetic");
    expect(failure.cause).toBeUndefined();
  });

  test.each(["exit 0", "printf '{broken-json}'"]) ("missing framed output is rejected: %s", async (script) => {
    await fakeShell(script);
    await expect(userShellEnvironment()).rejects.toMatchObject({ reason: "invalid_output" });
  });

  test("stdin is closed", async () => {
    await fakeShell("if read value; then exit 8; fi\nexit 0");
    await expect(userShellEnvironment({ timeoutMs: 3000 })).rejects.toMatchObject({ reason: "invalid_output" });
  });

  test("hanging startup has a deadline", async () => {
    await fakeShell("sleep 60");
    const started = Date.now();
    await expect(userShellEnvironment({ timeoutMs: 150 })).rejects.toMatchObject({ reason: "timed_out" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("abort is typed both before and during shell execution", async () => {
    await fakeShell("sleep 60");
    const controller = new AbortController();
    const pending = userShellEnvironment({ signal: controller.signal });
    controller.abort("synthetic-secret-cause");
    await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
    await expect(userShellEnvironment({ signal: controller.signal })).rejects.toMatchObject({ reason: "cancelled" });
  });

  test("excessive profile output fails instead of parsing a truncated snapshot", async () => {
    await fakeShell("yes synthetic-profile-output");
    await expect(userShellEnvironment()).rejects.toMatchObject({ reason: "output_too_large" });
  });
});

test("non-POSIX shells use their own quoting and external-command syntax", () => {
  const executable = String.raw`/a space/one'quote\two/node`;
  expect(shellEnvironmentCommand("fish", executable, "marker")).toMatchInlineSnapshot(`
    [
      "-i",
      "-l",
      "-c",
      "'/a space/one\\'quote\\\\two/node' '-e' 'process.stdout.write("marker" + JSON.stringify(process.env) + "marker")'",
    ]
  `);
  expect(shellEnvironmentCommand("nu", executable, "marker")).toMatchInlineSnapshot(`
    [
      "-i",
      "-l",
      "-c",
      "^r#'/a space/one'quote\\two/node'# r#'-e'# r#'process.stdout.write("marker" + JSON.stringify(process.env) + "marker")'#",
    ]
  `);
  expect(shellEnvironmentCommand("pwsh", executable, "marker")).toMatchInlineSnapshot(`
    [
      "-Login",
      "-Command",
      "& '/a space/one''quote\\two/node' '-e' 'process.stdout.write("marker" + JSON.stringify(process.env) + "marker")'",
    ]
  `);
});

test.each(["null", "[]", '{"HOME":42}', '{"HOME":"synthetic-private-value",}', '{"BAD=KEY":"value"}', String.raw`{"KEY":"bad\u0000value"}`])("rejects malformed framed environment %s without retaining it", (payload) => {
  expect(() => parseShellEnvironment(`before MARK${payload}MARK after`, "MARK")).toThrow(UserShellEnvironmentError);
});

test("custom commands and arguments are quoted by each shell dialect", () => {
  const executable = String.raw`/a space/one'quote\two/host`;
  const args = ["capture", "a b", "quote'\"", String.raw`back\slash`, "'##", "$(echo no)", "", "line\nbreak"];
  expect(["bash", "fish", "nu", "pwsh"].map((shell) => shellEnvironmentCommand(shell, executable, "marker", args))).toMatchInlineSnapshot(`
    [
      [
        "-i",
        "-l",
        "-c",
        "'/a space/one'"'"'quote\\two/host' 'capture' 'a b' 'quote'"'"'"' 'back\\slash' ''"'"'##' '$(echo no)' '' 'line
    break' 'marker'",
      ],
      [
        "-i",
        "-l",
        "-c",
        "'/a space/one\\'quote\\\\two/host' 'capture' 'a b' 'quote\\'"' 'back\\\\slash' '\\'##' '$(echo no)' '' 'line
    break' 'marker'",
      ],
      [
        "-i",
        "-l",
        "-c",
        "^r#'/a space/one'quote\\two/host'# r#'capture'# r#'a b'# r#'quote'"'# r#'back\\slash'# r###''##'### r#'$(echo no)'# r#''# r#'line
    break'# r#'marker'#",
      ],
      [
        "-Login",
        "-Command",
        "& '/a space/one''quote\\two/host' 'capture' 'a b' 'quote''"' 'back\\slash' '''##' '$(echo no)' '' 'line
    break' 'marker'",
      ],
    ]
  `);
});


test("the exported capture writer matches the default evaluator's framing without other effects", () => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  writeShellEnvironmentCapture("test-marker");
  const written = stdout.mock.calls[0]?.[0];
  const same = written === `test-marker${JSON.stringify(process.env)}test-marker`;
  const calls = stdout.mock.calls.length;
  stdout.mockRestore();
  // Never include the private snapshot in an assertion's diagnostic output.
  expect(same).toBe(true);
  expect(calls).toBe(1);
});

test("arguments without an explicit command are rejected before spawning", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.stubEnv("SHELL", "/bin/bash");
  vi.mocked(spawn).mockClear();
  await expect(userShellEnvironment({ args: ["capture"] })).rejects.toThrow("args requires command");
  expect(spawn).not.toHaveBeenCalled();
});
