import assert from "node:assert/strict";
import test from "node:test";
import type { execFileSync } from "node:child_process";
import {
  mergeWindowsEnvironmentScopes,
  mergeWindowsPathSegments,
  resolveCommandOnPath,
} from "./windowsCommandResolution.js";

test("mergeWindowsPathSegments: base first, then machine, then user; case-insensitive dedupe", () => {
  const merged = mergeWindowsPathSegments([
    "C:\\App;C:\\Windows",
    "C:\\Windows;C:\\MachineExtra",
    "c:\\app;C:\\UserExtra",
  ]);
  assert.equal(merged, "C:\\App;C:\\Windows;C:\\MachineExtra;C:\\UserExtra");
});

test("mergeWindowsEnvironmentScopes keeps base Path first", () => {
  const merged = mergeWindowsEnvironmentScopes(
    { Path: "C:\\Base" },
    { machine: { Path: "C:\\Machine" }, user: { Path: "C:\\User" } },
  );
  assert.equal(merged.Path, "C:\\Base;C:\\Machine;C:\\User");
});

test("resolveCommandOnPath on Windows prefers .cmd over .ps1 from Get-Command", () => {
  const execFileSyncFn = (() =>
    Buffer.from("C:\\Users\\test\\AppData\\Roaming\\npm\\claude.ps1\r\n")) as unknown as typeof execFileSync;
  const existsSyncFn = (filePath: string) =>
    filePath === "C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd";
  const resolved = resolveCommandOnPath("claude", {
    platform: "win32",
    env: {},
    execFileSyncFn,
    existsSyncFn,
    windowsEnvironmentReaderFn: () => null,
  });
  assert.equal(resolved, "C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd");
});

test("resolveCommandOnPath on Windows prefers .bat over .exe when .cmd is absent", () => {
  const execFileSyncFn = (() =>
    Buffer.from("C:\\Users\\test\\AppData\\Roaming\\npm\\claude.ps1\r\n")) as unknown as typeof execFileSync;
  const existsSyncFn = (filePath: string) =>
    filePath === "C:\\Users\\test\\AppData\\Roaming\\npm\\claude.bat";
  const resolved = resolveCommandOnPath("claude", {
    platform: "win32",
    env: {},
    execFileSyncFn,
    existsSyncFn,
    windowsEnvironmentReaderFn: () => null,
  });
  assert.equal(resolved, "C:\\Users\\test\\AppData\\Roaming\\npm\\claude.bat");
});

test("resolveCommandOnPath on Windows returns null when only .ps1 exists", () => {
  const execFileSyncFn = (() =>
    Buffer.from("C:\\Users\\test\\AppData\\Roaming\\npm\\claude.ps1\r\n")) as unknown as typeof execFileSync;
  const resolved = resolveCommandOnPath("claude", {
    platform: "win32",
    env: {},
    execFileSyncFn,
    existsSyncFn: () => false,
    windowsEnvironmentReaderFn: () => null,
  });
  assert.equal(resolved, null);
});

test("Windows env refresh failure is bounded fallback, no raw leak", () => {
  const codes: string[] = [];
  const resolved = resolveCommandOnPath("claude", {
    platform: "win32",
    env: { Path: "C:\\Windows" },
    execFileSyncFn: (() => {
      throw new Error("ECONNRESET powershell C:\\secret\\path Get-Command exploded token=abc");
    }) as unknown as typeof execFileSync,
    windowsEnvironmentReaderFn: () => null,
    onRefreshFailed: (code) => {
      codes.push(code);
    },
  });
  assert.equal(resolved, null);
  assert.deepEqual(codes, ["windows_env_refresh_failed"]);
});

test("resolveCommandOnPath on Windows merges Machine/User Path before Get-Command", () => {
  let seenPath: string | undefined;
  const execFileSyncFn = ((
    _cmd: string,
    _args: readonly string[],
    opts?: { env?: NodeJS.ProcessEnv },
  ) => {
    seenPath = opts?.env?.Path;
    return Buffer.from("C:\\UserBin\\claude.exe\r\n");
  }) as unknown as typeof execFileSync;
  const resolved = resolveCommandOnPath("claude", {
    platform: "win32",
    env: { Path: "C:\\Base" },
    execFileSyncFn,
    windowsEnvironmentReaderFn: () => ({
      machine: { Path: "C:\\Machine" },
      user: { Path: "C:\\UserBin" },
    }),
  });
  assert.equal(resolved, "C:\\UserBin\\claude.exe");
  assert.equal(seenPath, "C:\\Base;C:\\Machine;C:\\UserBin");
});
