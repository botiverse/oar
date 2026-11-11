import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { codexInstalledExecutableCandidates, desktopBuildExecutables } from "../../packages/oar/src/runtimes/codex/installation.js";

/** A build folder holding a `codex.exe` last written at `at` (seconds). */
async function build(bin: string, folder: string, at: number): Promise<void> {
  await mkdir(path.join(bin, folder));
  const file = path.join(bin, folder, "codex.exe");
  await writeFile(file, "");
  await utimes(file, at, at);
}

test("Windows codex candidates include the Desktop CLI's build folders after each fixed path, newest first", () => {
  const listed: string[] = [];
  const builds = (bin: string): readonly string[] => {
    listed.push(bin);
    return bin.includes("Programs") ? [] : [String.raw`D:\local\OpenAI\Codex\bin\5449c1f0f26f1f98\codex.exe`, String.raw`D:\local\OpenAI\Codex\bin\0aa11b22\codex.exe`];
  };
  assert.deepEqual(codexInstalledExecutableCandidates("win32", String.raw`C:\Users\oar`, { LOCALAPPDATA: String.raw`D:\local`, APPDATA: String.raw`D:\roam` }, builds), [
    String.raw`D:\roam\npm\codex.cmd`,
    String.raw`D:\local\Programs\OpenAI\Codex\bin\codex.exe`,
    String.raw`D:\local\OpenAI\Codex\bin\codex.exe`,
    String.raw`D:\local\OpenAI\Codex\bin\5449c1f0f26f1f98\codex.exe`,
    String.raw`D:\local\OpenAI\Codex\bin\0aa11b22\codex.exe`,
  ]);
  assert.deepEqual(listed, [String.raw`D:\local\Programs\OpenAI\Codex\bin`, String.raw`D:\local\OpenAI\Codex\bin`]);
});

test("Desktop build folders are read newest first, skipping folders without a CLI and an unreadable bin", async () => {
  const bin = await mkdtemp(path.join(tmpdir(), "oar-codex-builds-"));
  try {
    await Promise.all([["older", 1_000_000], ["newer", 2_000_000]].map(async ([folder, at]) => { await build(bin, String(folder), Number(at)); }));
    await mkdir(path.join(bin, "empty"));
    await writeFile(path.join(bin, "codex-command-runner.exe"), "");
    assert.deepEqual(desktopBuildExecutables(bin), [path.join(bin, "newer", "codex.exe"), path.join(bin, "older", "codex.exe")]);
    assert.deepEqual(desktopBuildExecutables(path.join(bin, "missing")), []);
  } finally { await rm(bin, { recursive: true, force: true }); }
});

