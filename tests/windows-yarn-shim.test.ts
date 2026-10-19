import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveWindowsShim, windowsSpawnTarget } from "../packages/oar/src/shared/executable/index.js";
import { launchers } from "./fixtures/windows-shim-fixtures.js";

// Captured on windows-latest by `yarn@1.22.22 global add cowsay` (oar#442).
// Only the temporary root is replaced below; both shim bodies are unchanged.
const YARN_OUTER = String.raw`@"%~dp0\..\yarn-global\node_modules\.bin\cowsay.cmd"   %*`;
const YARN_INNER = [
  String.raw`@IF EXIST "%~dp0\node.exe" (`,
  String.raw`  "%~dp0\node.exe"  "%~dp0\..\cowsay\cli.js" %*`,
  ") ELSE (", "  @SETLOCAL", String.raw`  @SET PATHEXT=%PATHEXT:;.JS;=;%`,
  String.raw`  node  "%~dp0\..\cowsay\cli.js" %*`, ")",
].join("\r\n");
const OUTER = String.raw`C:\yarn test\bin\cowsay.cmd`;
const INNER = String.raw`C:\yarn test\yarn-global\node_modules\.bin\cowsay.cmd`;
const SCRIPT = String.raw`C:\yarn test\yarn-global\node_modules\cowsay\cli.js`;

function resolveFixture(entries: readonly (readonly [string, string | null])[], command = OUTER) {
  const files = new Map(entries);
  return resolveWindowsShim(command, (candidate) => files.get(candidate) ?? null, (candidate) => files.has(candidate));
}

test("yarn's recorded outer and inner shims resolve to node and cli.js", () => {
  expect(resolveFixture([[OUTER, YARN_OUTER], [INNER, YARN_INNER]])).toEqual({ command: "node", prefixArgs: [SCRIPT] });
});

test("forwarded native targets are still launched directly", () => {
  const text = String.raw`@"%~dp0\tool.exe" %*`;
  expect(resolveFixture([[OUTER, YARN_OUTER], [INNER, text]])).toEqual({ command: path.win32.join(path.win32.dirname(INNER), "tool.exe"), prefixArgs: [] });
});

test.each(["@echo off\r\nnode absolute.js %*", null])("an unrecognized or unreadable inner shim becomes the fallback target: %j", (text) => {
  expect(resolveFixture([[OUTER, YARN_OUTER], [INNER, text]])).toEqual({ command: INNER, prefixArgs: [] });
});

test("a nonexistent target is not followed", () => {
  expect(resolveFixture([[OUTER, YARN_OUTER]])).toEqual({ command: OUTER, prefixArgs: [] });
});

test.each([
  `${YARN_OUTER} fixed`,
  YARN_OUTER.replace("   %*", " fixed %*"),
  `${YARN_OUTER}\r\necho another command`,
  String.raw`@"C:\absolute.cmd" %*`,
  String.raw`@"%~dp0\%OTHER%\cowsay.cmd" %*`,
  String.raw`@"%~dp0\!OTHER!\cowsay.cmd" %*`,
  String.raw`@"%~dp0\cowsay.py" %*`,
])("only a complete relative forwarding line is followed: %j", (text) => {
  expect(resolveFixture([[OUTER, text], [INNER, YARN_INNER]])).toEqual({ command: OUTER, prefixArgs: [] });
});

test("a batch target and variable whitespace are accepted", () => {
  const target = path.win32.join(path.win32.dirname(OUTER), "inner.bat");
  expect(resolveFixture([[OUTER, ' \t@"%~dp0\\inner.bat"\t%*\r\n'], [target, null]])).toEqual({ command: target, prefixArgs: [] });
});

test("a cycle stops at the last reached shim", () => {
  const text = String.raw`@"%~dp0\..\..\..\bin\cowsay.cmd" %*`;
  expect(resolveFixture([[OUTER, YARN_OUTER], [INNER, text]])).toEqual({ command: INNER, prefixArgs: [] });
});

test("three forwarding layers reach a recognized native target", () => {
  const files = new Map([
    [String.raw`C:\0.cmd`, String.raw`@"%~dp0\1.cmd" %*`],
    [String.raw`C:\1.cmd`, String.raw`@"%~dp0\2.cmd" %*`],
    [String.raw`C:\2.cmd`, String.raw`@"%~dp0\3.cmd" %*`],
    [String.raw`C:\3.cmd`, String.raw`@"%~dp0\tool.exe" %*`],
  ]);
  expect(resolveFixture([...files], String.raw`C:\0.cmd`)).toEqual({ command: String.raw`C:\tool.exe`, prefixArgs: [] });
});

test("a longer chain falls back to the third target without reading further", () => {
  const reads: string[] = [];
  const read = (candidate: string): string => {
    reads.push(candidate);
    return `@"%~dp0\\${reads.length}.cmd" %*`;
  };
  expect(resolveWindowsShim(String.raw`C:\0.cmd`, read, () => true)).toEqual({ command: String.raw`C:\3.cmd`, prefixArgs: [] });
  expect(reads).toEqual([String.raw`C:\0.cmd`, String.raw`C:\1.cmd`, String.raw`C:\2.cmd`, String.raw`C:\3.cmd`]);
});

function writeYarnShims(directory: string, recognized: boolean): string {
  const bin = path.join(directory, "bin");
  const inner = path.join(directory, "yarn-global", "node_modules", ".bin");
  const script = path.join(inner, "..", "cowsay", "cli.js");
  for (const dir of [bin, inner, path.dirname(script)]) { mkdirSync(dir, { recursive: true }); }
  writeFileSync(path.join(inner, "cowsay.cmd"), recognized ? YARN_INNER : `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n');
  const command = path.join(bin, "cowsay.cmd");
  writeFileSync(command, YARN_OUTER);
  return command;
}

function expectYarnTarget(command: string, args: readonly string[], recognized: boolean): void {
  const target = windowsSpawnTarget(command, args);
  expect(target.windowsVerbatimArguments).toBe(recognized ? undefined : true);
  if (!recognized) {
    expect(target.args.at(-1)).toContain(String.raw`\yarn-global\node_modules\.bin\cowsay.cmd`);
  }
}

describe.skipIf(process.platform !== "win32")("real two-layer yarn shims", () => {
  const cases = launchers.flatMap((launcher) => [true, false].map((recognized) => ({ launcher, recognized })));
  test.each(cases)("$launcher.name preserves arguments with a recognized inner shim=$recognized", async ({ launcher, recognized }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "oar yarn shim "));
    try {
      const command = writeYarnShims(directory, recognized);
      const marker = path.join(directory, "injected.txt");
      const args = ['odd" & b', 'quote" | pipe', `a" & echo INJECTED > "${marker}" & rem "`, "%OAR_SENTINEL%", "", "ends\\"];
      expectYarnTarget(command, args, recognized);
      const output = await launcher.run(command, args, { ...process.env, OAR_SENTINEL: "MUST_NOT_EXPAND" });
      expect(JSON.parse(output)).toEqual(args);
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});
