import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  devinInstallation,
  devinInstalledExecutableCandidates,
  readDevinVersion,
} from "../../packages/oar/src/runtimes/devin/installation.js";

const tempDirs: string[] = [];

function makeScratchDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeDevinWrapper(binDir: string, script: string): string {
  if (process.platform === "win32") {
    const cmd = path.join(binDir, "devin.cmd");
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return cmd;
  }
  const bin = path.join(binDir, "devin");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function writeDevinFixture(dir: string, subDir: string, options: { readonly helpExitCode?: number; readonly versionOutput?: string } = {}): string {
  const binDir = path.join(dir, subDir);
  mkdirSync(binDir, { recursive: true });
  const script = path.join(binDir, "devin-fixture.mjs");
  const helpExitCode = options.helpExitCode ?? 0;
  const versionOutput = options.versionOutput ?? "devin 3000.12.57 (96542e930752)\n";
  writeFileSync(
    script,
    [
      "const args = process.argv.slice(2);",
      `if (args[0] === 'acp' && args[1] === '--help') { process.exit(${String(helpExitCode)}); }`,
      `if (args[0] === '--version') { process.stdout.write(${JSON.stringify(versionOutput)}); process.exit(0); }`,
      "process.exit(2);",
    ].join("\n"),
  );
  return writeDevinWrapper(binDir, script);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readDevinVersion parses stable and prerelease CLI versions and rejects invalid strings", () => {
  expect(readDevinVersion("devin 3000.12.57 (96542e930752)\n")).toBe("3000.12.57");
  expect(readDevinVersion("devin 3000.12.57-beta.1 (96542e930752)\n")).toBe("3000.12.57-beta.1");
  expect(readDevinVersion("devin 3000.12.57-rc.2\n")).toBe("3000.12.57-rc.2");
  expect(readDevinVersion("devin 3000.12.57")).toBe("3000.12.57");

  for (const invalid of [
    "",
    "   \n",
    "3000.12.57",
    "devin v3000.12.57",
    "devin 3000.12",
    "other 3000.12.57 (96542e930752)",
    "devin 3000.12.57 (XYZ)",
    "devin 3000.12.57\nextra",
  ]) {
    expect(readDevinVersion(invalid), JSON.stringify(invalid)).toBeUndefined();
  }
});

test("devinInstalledExecutableCandidates returns POSIX and Windows fallback paths", () => {
  expect(devinInstalledExecutableCandidates("darwin", "/Users/alice", {})).toEqual(["/Users/alice/.local/bin/devin"]);
  expect(devinInstalledExecutableCandidates("linux", "/home/alice", {})).toEqual(["/home/alice/.local/bin/devin"]);
  expect(devinInstalledExecutableCandidates("win32", String.raw`C:\Users\alice`, { LOCALAPPDATA: String.raw`D:\AppData` })).toEqual([
    String.raw`D:\AppData\devin\cli\bin\devin.exe`,
  ]);
  expect(devinInstalledExecutableCandidates("win32", String.raw`C:\Users\alice`, { LocalAppData: String.raw`E:\Local` })).toEqual([
    String.raw`E:\Local\devin\cli\bin\devin.exe`,
  ]);
  expect(devinInstalledExecutableCandidates("win32", String.raw`C:\Users\alice`, {})).toEqual([
    String.raw`C:\Users\alice\AppData\Local\devin\cli\bin\devin.exe`,
  ]);
  expect(devinInstalledExecutableCandidates("win32", String.raw`C:\Users\alice`, { LOCALAPPDATA: "" })).toEqual([
    String.raw`C:\Users\alice\AppData\Local\devin\cli\bin\devin.exe`,
  ]);
});

test("devinInstallation verifies acp --help and --version via OAR_DEVIN_BIN", async () => {
  const dir = makeScratchDir("oar-devin-install-");
  const bin = writeDevinFixture(dir, "bin");
  expect(await devinInstallation({ env: { OAR_DEVIN_BIN: bin, PATH: "" } })).toEqual({
    kind: "available",
    via: "executable",
    command: bin,
    version: "3000.12.57",
  });

  const unsupportedBin = writeDevinFixture(dir, "bad", { helpExitCode: 1 });
  expect(await devinInstallation({ env: { OAR_DEVIN_BIN: unsupportedBin, PATH: "" } })).toEqual({
    kind: "unsupported",
    reason: "acp --help failed",
  });

  expect(await devinInstallation({ env: { OAR_DEVIN_BIN: path.join(dir, "missing-devin"), PATH: "" } })).toEqual({
    kind: "not_found",
  });
});

test.skipIf(process.platform === "win32")("devinInstallation falls back to ~/.local/bin/devin when off PATH", async () => {
  const home = makeScratchDir("oar-devin-home-");
  const bin = writeDevinFixture(home, ".local/bin", { versionOutput: "devin 3000.12.58-alpha.1 (abcdef123456)\n" });
  expect(await devinInstallation({ env: { HOME: home, PATH: "", OAR_DEVIN_BIN: "" } })).toEqual({
    kind: "available",
    via: "executable",
    command: bin,
    version: "3000.12.58-alpha.1",
  });
});
