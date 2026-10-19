import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runExecutable, windowsSpawnTarget } from "../packages/oar/src/shared/executable/index.js";
import { handwrittenShim, launchers, nodeShimText } from "./fixtures/windows-shim-fixtures.js";

const resolveGhost = (): string => String.raw`C:\ghost.cmd`;

const unrepresentable = ["first\nsecond", "first\rsecond", "first\r\nsecond", "first\0second"];
const refusal = "cmd.exe cannot preserve arguments containing CR, LF, or NUL";
async function expectExecutableRefusal(command: string, args: readonly string[], reason = refusal): Promise<void> {
  const result = await runExecutable(command, args);
  expect(result.ok).toBe(false);
  expect(result.diagnostics?.error?.message).toContain(reason);
}

test.each(unrepresentable)("unreadable shims refuse an argument containing a line break or NUL: %j", (argument) => {
  expect(() => windowsSpawnTarget("ghost", [argument], { platform: "win32", resolve: resolveGhost })).toThrow(refusal);
});

describe.skipIf(process.platform !== "win32")("Windows shim argument boundaries", () => {
  const cases = launchers.flatMap((launcher) => unrepresentable.map((argument) => ({ launcher, argument })));
  test.each(cases)("$launcher.name refuses unsupported argument %# before starting a handwritten shim", async ({ launcher, argument }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "oar refused shim "));
    const marker = path.join(directory, "started.txt");
    try {
      const command = handwrittenShim(directory, "cmd", marker);
      await (launcher.name === "runExecutable"
        ? expectExecutableRefusal(command, [argument])
        : expect(launcher.run(command, [argument], process.env)).rejects.toThrow(refusal));
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test.each(launchers)("$name still passes multiline arguments through a recognized npm shim", async (launcher) => {
    const directory = mkdtempSync(path.join(tmpdir(), "oar multiline shim "));
    try {
      const command = handwrittenShim(directory, "cmd");
      writeFileSync(command, nodeShimText("argv.cjs"));
      const args = ["--append-system-prompt", ...unrepresentable.slice(0, 3)];
      expect(JSON.parse(await launcher.run(command, args, process.env))).toEqual(args);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});

const tooLong = [
  { name: "long literal", argument: "x".repeat(9000) },
  { name: "escaped metacharacters", argument: "^".repeat(2100) },
];
const lengthRefusal = "cmd.exe command line exceeds its 8191-character limit after escaping";

test.each(tooLong)("unreadable shims refuse $name before spawning", ({ argument }) => {
  expect(() => windowsSpawnTarget("ghost", [argument], { platform: "win32", resolve: resolveGhost })).toThrow(lengthRefusal);
});

describe.skipIf(process.platform !== "win32")("Windows shim command length", () => {
  const cases = launchers.flatMap((launcher) => tooLong.map((item) => ({ launcher, ...item })));
  test.each(cases)("$launcher.name refuses $name before starting a handwritten shim", async ({ launcher, argument }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "oar long shim "));
    const marker = path.join(directory, "started.txt");
    try {
      const command = handwrittenShim(directory, "cmd", marker);
      await (launcher.name === "runExecutable"
        ? expectExecutableRefusal(command, [argument], lengthRefusal)
        : expect(launcher.run(command, [argument], process.env)).rejects.toThrow(lengthRefusal));
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test.each(launchers)("$name still delivers long arguments through a recognized npm shim", async (launcher) => {
    const directory = mkdtempSync(path.join(tmpdir(), "oar long direct shim "));
    try {
      const command = handwrittenShim(directory, "cmd");
      writeFileSync(command, nodeShimText("argv.cjs"));
      const args = tooLong.map(({ argument }) => argument);
      expect(JSON.parse(await launcher.run(command, args, process.env))).toEqual(args);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});
