import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

const reader = path.resolve(".github/scripts/runtime-version.mjs");

function run(script: string, args: string[], cwd: string) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", timeout: 10_000 });
}

async function fixture(manifest: unknown, args = ["fixture"]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oar-runtime pins-"));
  try {
    const scripts = path.join(directory, "scripts");
    await mkdir(scripts);
    const script = path.join(scripts, "runtime-version.mjs");
    await Promise.all([copyFile(reader, script),
      copyFile(path.resolve(".github/scripts/runtime-common.mjs"), path.join(scripts, "runtime-common.mjs"))]);
    if (manifest !== undefined) {
      await writeFile(path.join(directory, "runtime-versions.json"),
        typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    }
    return run(script, args, os.tmpdir());
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const pin = (entry: unknown) => ({ schemaVersion: 1, runtimes: { fixture: entry } });

test.each([
  ["claude-aimock", "@anthropic-ai/claude-code@2.1.326"],
  ["codex-aimock", "@openai/codex@0.169.0"],
  ["qwen-aimock", "@qwen-code/qwen-code@0.27.4"],
])("reads the accepted %s package independently of cwd", (backend, spec) => {
  const result = run(reader, [backend], os.tmpdir());
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(`${spec}\n`);
  expect(result.stderr).toBe("");
});

test.each([
  undefined, "{", null, [], {}, { schemaVersion: 2, runtimes: {} },
  { schemaVersion: 1, runtimes: [] }, { schemaVersion: 1, runtimes: {} }, pin(null),
].map(manifest => ({ manifest })))("fails without emitting an install spec for an unreadable or incomplete manifest: %j", async ({ manifest }) => {
  const result = await fixture(manifest);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/^Cannot read accepted CI runtime version: /u);
});

test.each([[], ["missing"], ["constructor"], ["__proto__"], ["fixture", "extra"]].map(args => ({ args })))(
  "fails for an absent or unknown backend: %j", async ({ args }) => {
    const result = await fixture(pin({ package: "fixture", version: "1.2.3" }), args);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Cannot read accepted CI runtime version: /u);
  });

test.each([undefined, "", "latest", "^1.2.3", "~1.2.3", "1.2", "1.2.x", "1.2.3 || 2.0.0", "v1.2.3", "1.2.3\n", "01.2.3", "1.2.3-01"])(
  "refuses a non-exact version: %j", async version => {
    const result = await fixture(pin({ package: "fixture", version }));
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Cannot read accepted CI runtime version: Expected an exact npm version for fixture/u);
  });

test.each([undefined, "", "--help", "file:./fixture", "https://example.invalid/pkg.tgz", "pkg@latest", "pkg\n", "pkg other"])(
  "refuses a package value that could select another install source: %j", async packageName => {
    const result = await fixture(pin({ package: packageName, version: "1.2.3" }));
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Cannot read accepted CI runtime version: Expected an npm package name for fixture/u);
  });

test("retains an exact prerelease and build identifier", async () => {
  const result = await fixture(pin({ package: "@fixture/runtime", version: "1.2.3-rc.5+build.7" }));
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("@fixture/runtime@1.2.3-rc.5+build.7\n");
});
