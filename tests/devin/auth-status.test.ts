import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { devinAuthStatus, devinRuntime, parseDevinAuthStatus } from "../../packages/oar/src/runtimes/devin/index.js";

const tempDirs: string[] = [];

function writeExecutable(dir: string, script: string): string {
  if (process.platform === "win32") {
    const cmd = path.join(dir, "devin.cmd");
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return cmd;
  }
  const bin = path.join(dir, "devin");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function writeAuthFixture(options: { readonly stdout: string; readonly exitCode?: number }): { readonly dir: string; readonly command: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-devin-auth-"));
  tempDirs.push(dir);
  const script = path.join(dir, "devin-auth.mjs");
  writeFileSync(
    script,
    [
      "const args = process.argv.slice(2);",
      `if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write(${JSON.stringify(options.stdout)}); process.exit(${String(options.exitCode ?? 0)}); }`,
      "process.exit(2);",
    ].join("\n"),
  );
  return { dir, command: writeExecutable(dir, script) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseDevinAuthStatus parses logged-out output", () => {
  expect(parseDevinAuthStatus("Not logged in.\nRun `devin auth login` to authenticate.\n")).toEqual({
    kind: "logged_out",
    source: "devin auth status",
    detail: "Run `devin auth login` in a terminal or set WINDSURF_API_KEY.",
  });
});

test("parseDevinAuthStatus parses browser login and never exposes Credentials path", () => {
  const secretPath = "/home/synthetic-user/.local/share/devin/secret-credentials.json";
  const stdout = [
    "Logged in (via browser).",
    "  Email: alice@example.test",
    `  Credentials path: ${secretPath}`,
    "",
  ].join("\n");
  const status = parseDevinAuthStatus(stdout);
  expect(status).toEqual({
    kind: "logged_in",
    account: { email: "alice@example.test", method: "browser" },
    source: "devin auth status",
  });
  expect(JSON.stringify(status)).not.toContain(secretPath);
  expect(JSON.stringify(status)).not.toContain("Credentials path");
});

test("parseDevinAuthStatus parses provided API key login", () => {
  const status = parseDevinAuthStatus("Logged in with provided API key.\n");
  expect(status).toEqual({
    kind: "logged_in",
    account: { credential: "api_key" },
    source: "devin auth status",
  });
});

test("parseDevinAuthStatus returns unknown for unexpected output", () => {
  expect(parseDevinAuthStatus("checking auth...\n")).toEqual({
    kind: "unknown",
    source: "devin auth status",
    detail: "devin auth status ended without saying whether it is signed in",
  });
  expect(parseDevinAuthStatus("")).toEqual({
    kind: "unknown",
    source: "devin auth status",
    detail: "devin auth status ended without saying whether it is signed in",
  });
});

test("devinAuthStatus returns unknown with WINDSURF_API_KEY configured without leaking the secret or spawning devin", async () => {
  const secret = "sk-synthetic-windsurf-secret";
  const { command } = writeAuthFixture({ stdout: "unexpected failure", exitCode: 1 });
  const status = await devinAuthStatus(
    { kind: "available", via: "executable", command, version: "3000.12.57" },
    { env: { WINDSURF_API_KEY: secret } },
  );
  expect(status).toEqual({
    kind: "unknown",
    source: "devin auth status",
    configured: ["environment: WINDSURF_API_KEY"],
    detail: "WINDSURF_API_KEY is configured; devin auth status inspects stored login credentials and does not validate this environment key.",
  });
  expect(JSON.stringify(status)).not.toContain(secret);
});

test("devinAuthStatus runs devin auth status cleanly for logged-out, logged-in, and failing exits", async () => {
  const loggedOut = writeAuthFixture({ stdout: "Not logged in.\n" });
  expect(
    await devinAuthStatus(
      { kind: "available", via: "executable", command: loggedOut.command },
      { env: { WINDSURF_API_KEY: null } },
    ),
  ).toMatchObject({ kind: "logged_out", source: "devin auth status" });

  const secretPath = "/tmp/synthetic-creds-path/auth.json";
  const loggedIn = writeAuthFixture({
    stdout: `Logged in (via browser).\n  Email: bob@example.test\n  Credentials path: ${secretPath}\n`,
  });
  const loggedInResult = await devinAuthStatus(
    { kind: "available", via: "executable", command: loggedIn.command },
    { env: { WINDSURF_API_KEY: null } },
  );
  expect(loggedInResult).toEqual({
    kind: "logged_in",
    account: { email: "bob@example.test", method: "browser" },
    source: "devin auth status",
  });
  expect(JSON.stringify(loggedInResult)).not.toContain(secretPath);

  const failed = writeAuthFixture({ stdout: "Logged in.\n", exitCode: 1 });
  expect(
    await devinAuthStatus(
      { kind: "available", via: "executable", command: failed.command },
      { env: { WINDSURF_API_KEY: null } },
    ),
  ).toEqual({
    kind: "unknown",
    source: "devin auth status",
    detail: "devin auth status ended without saying whether it is signed in",
  });

  expect(devinRuntime.authStatus).not.toHaveProperty("localOnly", true);
});
