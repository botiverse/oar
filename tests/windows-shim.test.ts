import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { escapeWindowsShimArgument, isWindowsShim, parseWindowsShim, runExecutable, spawnLineProcess, windowsSpawnTarget } from "../packages/oar/src/shared/executable/index.js";
import { handwrittenShim, launchers, nodeShimText } from "./fixtures/windows-shim-fixtures.js";

// Real cmd-shim output (npm/pnpm, cmd-shim 7): a Node CLI whose target has a
// shebang gets the `_prog` form; a directly-executable target gets the bare
// form. #395 follow-up: the shim's `%*` is what cmd.exe re-parses, so OAR
// must launch the Node target itself, never the shim through a shell.
// Exact shims captured from the windows-latest runner (#411): claude's npm
// bin is a native .exe (direct form), codex's is a .js (node form).
const CLAUDE_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
  String.raw`"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*`,
].join("\r\n");
const CODEX_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  String.raw`IF EXIST "%dp0%\node.exe" (`, String.raw`  SET "_prog=%dp0%\node.exe"`, ") ELSE (", `  SET "_prog=node"`, String.raw`  SET PATHEXT=%PATHEXT:;.JS;=;%`, ")", "",
  String.raw`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*`,
].join("\r\n");
const PNPM_SHIM = [
  "@SETLOCAL", String.raw`@IF EXIST "%~dp0\node.exe" (`,
  String.raw`  "%~dp0\node.exe"  "%~dp0\global\5\node_modules\@openai\codex\bin\codex.js" %*`,
  ") ELSE (", String.raw`  @SET PATHEXT=%PATHEXT:;.JS;=;%`,
  String.raw`  node  "%~dp0\global\5\node_modules\@openai\codex\bin\codex.js" %*`, ")",
].join("\r\n");
const NODE_EXE = String.raw`C:\npm\prefix\node.exe`;
const CODEX_JS = String.raw`C:\npm\prefix\node_modules\@openai\codex\bin\codex.js`;
const NODE_BIN = String.raw`C:\node\node.exe`;
const resolveNode = (name: string): string | null => (name === "node" ? NODE_BIN : null);
const resolveGhost = (name: string): string | null => (name === "ghost" ? String.raw`C:\ghost.cmd` : null);

test("isWindowsShim matches .cmd and .bat only, ignoring case", () => {
  for (const yes of ["claude.cmd", "CLAUDE.CMD", "tool.bat", String.raw`C:\npm\claude.cmd`]) {
    expect(isWindowsShim(yes), yes).toBe(true);
  }
  for (const no of ["claude.exe", "claude", "cli.js", "node.exe"]) {
    expect(isWindowsShim(no), no).toBe(false);
  }
});

test("a Node-CLI shim resolves to the bundled node.exe and the wrapped script", () => {
  expect(parseWindowsShim(String.raw`C:\npm\prefix\codex.CMD`, CODEX_SHIM, (candidate) => candidate === NODE_EXE)).toEqual({ command: NODE_EXE, prefixArgs: [CODEX_JS] });
});

test("without a bundled node.exe the shim falls back to node on PATH", () => {
  expect(parseWindowsShim(String.raw`C:\npm\prefix\codex.CMD`, CODEX_SHIM, () => false)).toEqual({ command: "node", prefixArgs: [CODEX_JS] });
});

test("a pnpm shim (%~dp0, no _prog) resolves to node and the wrapped script", () => {
  const codexJs = String.raw`C:\pnpm\global\5\node_modules\@openai\codex\bin\codex.js`;
  expect(parseWindowsShim(String.raw`C:\pnpm\codex.cmd`, PNPM_SHIM, () => false)).toEqual({ command: "node", prefixArgs: [codexJs] });
});

test("a native-exe shim (npm bin is an .exe, e.g. claude) resolves to the exe, no node", () => {
  const shim = parseWindowsShim(String.raw`C:\npm\prefix\claude.CMD`, CLAUDE_SHIM, () => false);
  expect(shim).toEqual({ command: String.raw`C:\npm\prefix\node_modules\@anthropic-ai\claude-code\bin\claude.exe`, prefixArgs: [] });
});

test("a shim whose target is neither a node script nor a native exe is unreadable", () => {
  const other = ["@echo off", String.raw`"%dp0%\run.py" %*`].join("\r\n");
  expect(parseWindowsShim(String.raw`C:\x\weird.cmd`, other, () => false)).toBeNull();
  expect(parseWindowsShim(String.raw`C:\x\empty.cmd`, "@echo off\r\nexit /b 0", () => false)).toBeNull();
});

test("a hand-rolled .cmd (absolute node + script + extra arg, not an npm shim) is left alone", () => {
  // tests/fixtures/login-fixtures.ts writes exactly this shape for fake CLIs.
  const fake = String.raw`@"C:\Program Files\nodejs\node.exe" "C:\t\fake-login.mjs" "C:\t\state.json" %*`;
  expect(parseWindowsShim(String.raw`C:\t\claude-1.cmd`, fake, () => false)).toBeNull();
});

test("windowsSpawnTarget is a no-op off Windows, so posix launches are unchanged", () => {
  const injection = ["--append-system-prompt", String.raw`say "hi" | echo pwned`];
  expect(windowsSpawnTarget("/usr/bin/claude", injection, { platform: "linux" })).toEqual({ command: "/usr/bin/claude", args: injection });
  expect(windowsSpawnTarget("claude.cmd", injection, { platform: "darwin" })).toEqual({ command: "claude.cmd", args: injection });
});

test("windowsSpawnTarget leaves a non-shim command alone on Windows", () => {
  expect(windowsSpawnTarget(NODE_BIN, ["cli.js"], { platform: "win32", resolve: resolveNode })).toEqual({ command: NODE_BIN, args: ["cli.js"] });
  expect(windowsSpawnTarget("where-is-it", [], { platform: "win32", resolve: () => null })).toEqual({ command: "where-is-it", args: [] });
});

test("an unreadable shim falls back to explicit cmd.exe with already escaped arguments", () => {
  const target = windowsSpawnTarget("ghost", ["x"], { platform: "win32", resolve: resolveGhost });
  expect(path.win32.basename(target.command).toLowerCase()).toBe("cmd.exe");
  expect(target.args).toEqual(["/d", "/s", "/c", String.raw`"^"C:\ghost.cmd^" ^^^"x^^^""`]);
  expect(target.windowsVerbatimArguments).toBe(true);
});

// On Windows, end to end: a real `.cmd` shim wrapping a Node script that
// reports its argv. spawnLineProcess must deliver tricky arguments verbatim,
// where launching the shim through cmd.exe would split them at a
// metacharacter after an unbalanced quote (#395 follow-up).
/** Launch a `.cmd` shim wrapping an argv-reporting Node script through OAR; the argv the script received. */
async function argvThroughShim(dir: string, args: readonly string[]): Promise<readonly string[]> {
  writeFileSync(path.join(dir, "argv.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(path.join(dir, "argv.cmd"), nodeShimText("argv.js"));
  const child = spawnLineProcess(path.join(dir, "argv.cmd"), args);
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  await once(child.stdout, "end");
  await child.exited;
  const parsed: unknown = JSON.parse(out);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

test.skipIf(process.platform !== "win32")("spawnLineProcess delivers tricky args through a .cmd shim verbatim", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-shim-e2e-"));
  const tricky = ["--append-system-prompt", String.raw`say "hi" | echo & dir > x ^ %PATH% ! ) "`, "plain", "with space"];
  try {
    expect(await argvThroughShim(dir, tricky)).toEqual(tricky);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

const escaping = [
  ["", String.raw`^^^"^^^"`],
  ["plain", String.raw`^^^"plain^^^"`],
  ["two words", String.raw`^^^"two^^^ words^^^"`],
  ['a"b', String.raw`^^^"a\^^^"b^^^"`],
  [String.raw`a\"b`, String.raw`^^^"a\\\^^^"b^^^"`],
  ["ends\\", String.raw`^^^"ends\\^^^"`],
  ["a&b", String.raw`^^^"a^^^&b^^^"`],
  ["a|b", String.raw`^^^"a^^^|b^^^"`],
  ["a<b", String.raw`^^^"a^^^<b^^^"`],
  ["a>b", String.raw`^^^"a^^^>b^^^"`],
  ["a^b", String.raw`^^^"a^^^^b^^^"`],
  ["%NAME%", String.raw`^^^"^^^%NAME^^^%^^^"`],
  ["!NAME!", String.raw`^^^"^^^!NAME^^^!^^^"`],
  ["(a)", String.raw`^^^"^^^(a^^^)^^^"`],
] as const;

function childPathEnv(directory: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) { if (key.toUpperCase() === "PATH") { delete env[key]; } }
  env.Path = directory;
  return env;
}

describe.skipIf(process.platform !== "win32")("unrecognized Windows shims", () => {
  test.each(escaping)("escapes %j for both command passes", (argument, expected) => {
    expect(escapeWindowsShimArgument(argument)).toBe(expected);
  });

  const cases = launchers.flatMap((launcher) => ["cmd", "bat"].flatMap((extension) =>
    ["global tools", "node_modules/.bin"].map((location) => ({ launcher, extension, location }))));
  test.each(cases)("$launcher.name preserves argv through $location/argv.$extension", async ({ launcher, extension, location }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "oar cmd escaping "));
    try {
      const command = handwrittenShim(path.join(directory, location), extension);
      const marker = path.join(directory, "injection-marker.txt");
      const payload = `a" & echo INJECTED > "${marker}" & rem "`;
      const args = ["--append-system-prompt", payload, ...escaping.map(([argument]) => argument), "%OAR_ESCAPE_SENTINEL%"];
      const output = await launcher.run(command, args, { ...process.env, OAR_ESCAPE_SENTINEL: "MUST_NOT_EXPAND" });
      expect(JSON.parse(output)).toEqual(args);
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);

  const pathCases = launchers.flatMap((launcher) => ["argv", "argv.cmd"].map((command) => ({ launcher, command })));
  test.each(pathCases)("$launcher.name also escapes $command found only in the child's PATH", async ({ launcher, command }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "oar child path "));
    try {
      handwrittenShim(directory, "cmd");
      const args = ['odd" & echo MUST_NOT_RUN', "", "two words"];
      const output = await launcher.run(command, args, childPathEnv(directory));
      expect(JSON.parse(output)).toEqual(args);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);

  test("runExecutable resolves a relative shim against the child's cwd", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "oar child cwd "));
    try {
      handwrittenShim(directory, "bat");
      const args = ['odd" & echo MUST_NOT_RUN'];
      const result = await runExecutable(String.raw`.\argv.bat`, args, { cwd: directory });
      expect(result.ok, result.stderr).toBe(true);
      expect(JSON.parse(result.stdout)).toEqual(args);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});
