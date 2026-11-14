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

test("parseDevinAuthStatus parses missing credentials.toml output without exposing Credentials path", () => {
  const secretPath = "/tmp/devin-probe/data/devin/credentials.toml";
  const stdout = [
    "Not logged in.",
    `  Credentials path: ${secretPath}`,
    "Run `devin auth login` to authenticate.",
    "",
  ].join("\n");
  const status = parseDevinAuthStatus(stdout);
  expect(status).toEqual({
    kind: "logged_out",
    source: "devin auth status",
    detail: "Run `devin auth login` in a terminal or set WINDSURF_API_KEY.",
  });
  expect(JSON.stringify(status)).not.toContain(secretPath);
  expect(JSON.stringify(status)).not.toContain("Credentials path");
});

test("parseDevinAuthStatus parses corrupt credentials.toml output as unknown without configured", () => {
  const secretPath = "/tmp/devin-probe/data/devin/credentials.toml";
  const stdout = [
    "Failed to load credentials: TOML parse error at line 1, column 9",
    "  |",
    "1 | invalid =",
    "  |         ^",
    `  Credentials path: ${secretPath}`,
    "Run `devin auth login` to (re-)authenticate.",
    "",
  ].join("\n");
  const status = parseDevinAuthStatus(stdout);
  expect(status).toEqual({
    kind: "unknown",
    source: "devin auth status",
    detail: "devin auth status reported unreadable stored credentials",
  });
  expect(JSON.stringify(status)).not.toContain(secretPath);
});

test("parseDevinAuthStatus maps server-rejected stored credentials to logged_out", () => {
  const secretPath = "/tmp/devin-probe/data/devin/credentials.toml";
  const stdout = [
    "Logged in (via Devin).",
    "",
    "Credentials:",
    `  File:              ${secretPath}`,
    "  API server:        https://server.self-serve.windsurf.com",
    "  Devin webapp:      https://app.devin.ai",
    "  Devin API:         https://api.devin.ai",
    "",
    "User / team info:",
    "  Failed to fetch from server: Authentication required: invalid api key",
    "",
  ].join("\n");
  const status = parseDevinAuthStatus(stdout);
  expect(status).toEqual({
    kind: "logged_out",
    source: "devin auth status",
    detail: "Stored Devin credentials were rejected by the server. Run `devin auth logout` and `devin auth login` to re-authenticate.",
  });
  expect(JSON.stringify(status)).not.toContain(secretPath);
});

test.each([
  "  Failed to fetch from server: error sending request for url",
  "  Unavailable: service temporarily unreachable",
])("parseDevinAuthStatus maps transient server check failure (%s) to unknown with stored credentials", (failureLine) => {
  const secretPath = "/tmp/devin-probe/data/devin/credentials.toml";
  const stdout = [
    "Logged in (via Devin).",
    "",
    "Credentials:",
    `  File:              ${secretPath}`,
    "  API server:        https://server.self-serve.windsurf.com",
    "",
    "User / team info:",
    failureLine,
    "",
  ].join("\n");
  const status = parseDevinAuthStatus(stdout);
  expect(status).toEqual({
    kind: "unknown",
    source: "devin auth status",
    configured: ["stored credentials"],
    detail: "devin auth status found stored credentials and could not verify them with the server",
  });
  expect(JSON.stringify(status)).not.toContain(secretPath);
});

test("parseDevinAuthStatus parses Logged in (via Devin). and Logged in (via API key). without exposing File path", () => {
  const secretPath = "/tmp/devin-probe/data/devin/credentials.toml";
  const devinStdout = [
    "Logged in (via Devin).",
    "",
    "Credentials:",
    `  File:              ${secretPath}`,
    "  API server:        https://server.self-serve.windsurf.com",
    "  Devin webapp:      https://app.devin.ai",
    "  Devin API:         https://api.devin.ai",
    "",
  ].join("\n");
  const devinStatus = parseDevinAuthStatus(devinStdout);
  expect(devinStatus).toEqual({
    kind: "logged_in",
    account: { method: "Devin", credential: "account" },
    source: "devin auth status",
  });
  expect(JSON.stringify(devinStatus)).not.toContain(secretPath);

  const apiKeyStdout = [
    "Logged in (via API key).",
    "",
    "Credentials:",
    `  File:              ${secretPath}`,
    "  API server:        https://server.self-serve.windsurf.com",
    "",
  ].join("\n");
  expect(parseDevinAuthStatus(apiKeyStdout)).toEqual({
    kind: "logged_in",
    account: { method: "API key", credential: "api_key" },
    source: "devin auth status",
  });
});

test("parseDevinAuthStatus extracts email and plan from full 3000.12.57 output while stripping paths, names, IDs, and URLs", () => {
  const secretPath = "/tmp/devin-probe/data/devin/credentials.toml";
  const stdout = [
    "Logged in (via Devin).",
    "",
    "Credentials:",
    `  File:              ${secretPath}`,
    "  API server:        https://server.self-serve.windsurf.com",
    "  Devin webapp:      https://app.devin.ai",
    "  Devin API:         https://api.devin.ai",
    "",
    "User:",
    "  Name:              Alice Example (Plan: Spoofed)",
    "  Email:             alice@example.com",
    "  User ID:           usr_01synthetic99",
    "",
    "Account:",
    "  Tier:              Teams",
    "  Plan:              Teams",
    "  Team ID:           team_01synthetic88",
    "  Team membership:   Approved",
    "  Enterprise:        no",
    "  Primary org:       org_01synthetic77",
    "  Telemetry:         disabled (zero-data-retention)",
    "",
    "Team settings:",
    "  Allowed models:    all models allowed",
    "  MCP servers:       allowed (no restrictions)",
    "  Sandbox:           optional",
    "  Fetched at:        2026-11-14 08:30:00 UTC",
    "",
  ].join("\n");
  const status = parseDevinAuthStatus(stdout);
  expect(status).toEqual({
    kind: "logged_in",
    source: "devin auth status",
    account: { method: "Devin", credential: "account", email: "alice@example.com", plan: "Teams" },
  });
  const serialized = JSON.stringify(status);
  for (const redacted of [secretPath, "Alice Example", "Spoofed", "usr_01synthetic99", "team_01synthetic88", "org_01synthetic77", "windsurf.com", "app.devin.ai", "api.devin.ai"]) {
    expect(serialized).not.toContain(redacted);
  }
});

test("parseDevinAuthStatus scopes User and Account fields, parses API key details, and omits absent fields", () => {
  const apiKeyStdout = "Logged in (via API key).\n\nUser:\n  Plan:              WrongSectionPlan\n  Email:             key-owner@example.com\n\nAccount:\n  Email:             wrong-section@example.com\n  Plan:              Enterprise\n";
  expect(parseDevinAuthStatus(apiKeyStdout)).toEqual({
    kind: "logged_in",
    source: "devin auth status",
    account: { method: "API key", credential: "api_key", email: "key-owner@example.com", plan: "Enterprise" },
  });

  const noUserDetailsStdout = "Logged in (via Devin).\n\nUser:\n  (no user details returned by server)\n\nAccount:\n  Tier:              Teams\n  Team membership:   Approved\n";
  expect(parseDevinAuthStatus(noUserDetailsStdout)).toEqual({
    kind: "logged_in",
    source: "devin auth status",
    account: { method: "Devin", credential: "account" },
  });

  const nameOnlyStdout = "Logged in (via UnknownMethod).\n\nUser:\n  Name:              Bob Example\n\nAccount:\n  Enterprise:        yes\n";
  expect(parseDevinAuthStatus(nameOnlyStdout)).toEqual({
    kind: "logged_in",
    source: "devin auth status",
    account: { method: "UnknownMethod" },
  });
});

test("parseDevinAuthStatus returns unknown for unexpected or unobserved REPL output", () => {
  const expected = {
    kind: "unknown",
    source: "devin auth status",
    detail: "devin auth status ended without saying whether it is signed in",
  };
  for (const stdout of ["Logged in with provided API key.\n", "checking auth...\n", ""]) {
    expect(parseDevinAuthStatus(stdout)).toEqual(expected);
  }
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
  const loggedOut = writeAuthFixture({
    stdout: "Not logged in.\n  Credentials path: /tmp/devin-probe/data/devin/credentials.toml\nRun `devin auth login` to authenticate.\n",
  });
  expect(
    await devinAuthStatus(
      { kind: "available", via: "executable", command: loggedOut.command },
      { env: { WINDSURF_API_KEY: null } },
    ),
  ).toMatchObject({ kind: "logged_out", source: "devin auth status" });

  const secretPath = "/tmp/synthetic-creds-path/credentials.toml";
  const loggedIn = writeAuthFixture({
    stdout: `Logged in (via Devin).\n\nCredentials:\n  File:              ${secretPath}\n  API server:        https://server.self-serve.windsurf.com\n`,
  });
  const loggedInResult = await devinAuthStatus(
    { kind: "available", via: "executable", command: loggedIn.command },
    { env: { WINDSURF_API_KEY: null } },
  );
  expect(loggedInResult).toEqual({
    kind: "logged_in",
    account: { method: "Devin", credential: "account" },
    source: "devin auth status",
  });
  expect(JSON.stringify(loggedInResult)).not.toContain(secretPath);

  const failed = writeAuthFixture({ stdout: "Logged in (via Devin).\n", exitCode: 1 });
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
