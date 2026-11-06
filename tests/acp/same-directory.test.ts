import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { sameDirectory } from "../../packages/oar/src/shared/same-directory.js";

test.each(([
  ["/D:/a/oar/oar", String.raw`D:\a\oar\oar`, "win32", true],
  ["/C:/Users/test/AppData/Local/Temp/session", "C:/Users/test/AppData/Local/Temp/session", "win32", true],
  ["/D:/a/oar/oar", "C:/a/oar/oar", "win32", false],
  ["/D:/a/oar/oar", "D:/a/oar/other", "win32", false],
  ["/D:/a/oar/oar", "D:/a/oar/oar", "linux", false],
  ["/D:relative", "D:/relative", "win32", false],
  [String.raw`\\server\share\session`, "//server/share/session", "win32", true],
  ["/D:/a/space%20name", "D:/a/space name", "win32", false],
] as const).map(([saved, requested, platform, equal]) => ({ saved, requested, platform, equal })))("saved directory $saved and resume $requested on $platform agree: $equal", ({ saved, requested, platform, equal }) => {
  expect(sameDirectory(saved, requested, platform)).toBe(equal);
});

const root = mkdtempSync(path.join(tmpdir(), "oar-same-directory-"));
const saved = path.join(root, "Saved Session");
const other = path.join(root, "Other Session");
mkdirSync(saved);
mkdirSync(other);
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

test("existing directory aliases agree without accepting another directory", () => {
  const alias = path.join(root, "alias");
  symlinkSync(saved, alias, process.platform === "win32" ? "junction" : "dir");
  expect(sameDirectory(saved, alias)).toBe(true);
  expect(sameDirectory(alias, saved)).toBe(true);
  expect(sameDirectory(saved, other)).toBe(false);
  expect(sameDirectory(alias, other)).toBe(false);
});

test("missing paths keep lexical resolution without inventing aliases or folding case", () => {
  const missing = path.join(root, "Missing Session");
  expect(sameDirectory(missing, path.join(missing, "..", "Missing Session"))).toBe(true);
  expect(sameDirectory(missing, path.join(root, "missing session"))).toBe(false);
  expect(sameDirectory(missing, saved)).toBe(false);
});

test.skipIf(process.platform !== "win32")("Windows existing directory names and drive letters may differ in case", (context) => {
  const longPath = realpathSync.native(saved);
  const lower = longPath.toLowerCase();
  const upper = longPath.toUpperCase();
  if (!existsSync(lower) || !existsSync(upper)) {
    context.skip("This temporary directory requires case-sensitive lookup.");
  }
  expect(lower).not.toBe(upper);
  console.info("Windows directory casing", {
    node: process.version,
    jsRealpathAgrees: realpathSync(lower) === realpathSync(upper),
    nativeRealpathAgrees: realpathSync.native(lower) === realpathSync.native(upper),
  });
  expect(sameDirectory(lower, upper)).toBe(true);
  expect(sameDirectory(upper, lower)).toBe(true);
  expect(sameDirectory(lower, other)).toBe(false);
});

test.skipIf(process.platform !== "win32")("Windows real 8.3 and long directory names identify the same saved directory", (context) => {
  const longPath = realpathSync.native(saved);
  // Query the filesystem's actual alias; volumes without short names skip explicitly.
  const shortPath = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:OAR_DIRECTORY_LONG_PATH).ShortPath",
  ].join("; ")], {
    env: { ...process.env, OAR_DIRECTORY_LONG_PATH: longPath },
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  }).trim();
  expect(path.isAbsolute(shortPath), shortPath).toBe(true);
  if (shortPath.toLowerCase() === longPath.toLowerCase()) {
    context.skip("The temporary directory has no distinct Windows 8.3 short name.");
  }
  console.info("Windows directory 8.3 alias", {
    node: process.version,
    jsRealpathAgrees: realpathSync(shortPath) === realpathSync(longPath),
    nativeRealpathAgrees: realpathSync.native(shortPath) === realpathSync.native(longPath),
  });
  const evidence = JSON.stringify({ longPath, shortPath });
  expect(sameDirectory(longPath, shortPath), evidence).toBe(true);
  expect(sameDirectory(shortPath, longPath), evidence).toBe(true);
  expect(sameDirectory(shortPath, other)).toBe(false);
});
