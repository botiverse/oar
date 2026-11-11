import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { codexInstalledExecutableCandidates, desktopBuildExecutables } from "../../packages/oar/src/runtimes/codex/installation-candidates.js";

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

test("Desktop build folders are read newest first, at most three, skipping dot folders, folders without a CLI and an unreadable bin", async () => {
  const bin = await mkdtemp(path.join(tmpdir(), "oar-codex-builds-"));
  try {
    await Promise.all([["oldest", 1_000_000], ["older", 2_000_000], ["newer", 3_000_000], ["newest", 4_000_000], [".sandbox-bin", 5_000_000]].map(async ([folder, at]) => { await build(bin, String(folder), Number(at)); }));
    await mkdir(path.join(bin, "empty"));
    await writeFile(path.join(bin, "codex-command-runner.exe"), "");
    assert.deepEqual(desktopBuildExecutables(bin), [path.join(bin, "newest", "codex.exe"), path.join(bin, "newer", "codex.exe"), path.join(bin, "older", "codex.exe")]);
    assert.deepEqual(desktopBuildExecutables(path.join(bin, "missing")), []);
  } finally { await rm(bin, { recursive: true, force: true }); }
});


test("the candidates module, a public subpath, imports only Node built-ins and a type-only environment helper", () => {
  const source = readFileSync(path.join(import.meta.dirname, "../../packages/oar/src/runtimes/codex/installation-candidates.ts"), "utf8");
  const imports = [...source.matchAll(/^import .* from "(?<from>[^"]+)";$/gmu)].map((match) => match.groups?.from);
  assert.deepEqual(imports, ["node:fs", "node:os", "node:path", "../../shared/environment.js"]);
  const manifest: unknown = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../packages/oar/package.json"), "utf8"));
  assert.deepEqual(asRecord(asRecord(manifest)?.exports)?.["./runtimes/codex/installation-candidates"], { types: "./dist/runtimes/codex/installation-candidates.d.ts", import: "./dist/runtimes/codex/installation-candidates.js" });
});
