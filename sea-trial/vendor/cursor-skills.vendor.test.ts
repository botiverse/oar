import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { createCursorRuntime } from "../../packages/oar/src/runtimes/cursor/index.js";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { nativeRows } from "../../packages/oar/src/shared/inventory.js";
import { cursorSkillsFixture } from "../../tests/fixtures/cursor-skills.js";

const installation = { kind: "available", via: "bundled" } as const;
describe.skipIf(process.env.OAR_TEST !== "cursor-skills")("Cursor SDK native skill discovery parity", () => {
  test.for([false, true])("same fixtures in a Git workspace: %s", { timeout: 60_000 }, async (git) => {
    const f = await cursorSkillsFixture(git);
    const copy = await mkdtemp(join(tmpdir(), "oar-cursor-sdk-observer-"));
    const output = join(copy, "result.json");
    const dir = resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "cursor-skills");
    try {
      // Exercise unresolved package links as well as canonical pnpm paths.
      const native = await runExecutable(process.execPath, ["--preserve-symlinks", "--import", import.meta.resolve("tsx"), resolve("sea-trial/vendor/support/cursor-skills-native.ts"), f.cwd, copy, output], { cwd: f.cwd, env: f.env, timeoutMs: 45_000 });
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${String(git)}-native.log`), `${native.stdout}\n${native.stderr}`);
      assert.ok(native.ok, JSON.stringify(native));
      const report = asRecord(parseJson(await readFile(output, "utf8")));
      assert.ok(report !== null);
      const manifest = new URL("../../package.json", import.meta.resolve("@cursor/sdk"));
      const installed = asRecord(parseJson(await readFile(manifest, "utf8")));
      assert.ok(typeof installed?.version === "string");
      expect(report.version).toBe(installed.version);
      const rows = nativeRows(report.skills);
      const runtime = createCursorRuntime({ execution: "subprocess", sdkModule: import.meta.resolve("@cursor/sdk"), envBase: "clean" });
      const env = Object.fromEntries(Object.entries(f.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      const discovered = await runtime.skills(installation, { cwd: f.cwd, env });
      assert.equal(discovered.kind, "ok", JSON.stringify(discovered));
      const expected = await Promise.all(rows.filter(row => row.invalid === false).map(async row => {
        assert.ok(typeof row.path === "string");
        return { name: basename(dirname(row.path)), path: await realpath(row.path), description: row.description, disableModelInvocation: row.disableModelInvocation };
      }));
      const actual = await Promise.all(discovered.items.map(async item => ({ name: item.name, path: await realpath(item.path ?? ""), description: item.description, disableModelInvocation: item.disableModelInvocation })));
      expect(actual.toSorted(byPath)).toEqual(expected.toSorted(byPath));
      expect(discovered.partial).toBe(rows.some(row => row.invalid === true));
      expect(discovered.view).toBe("discovered");
      expect(discovered.items.filter(item => item.scope === "user")).toHaveLength(5);
      expect(discovered.items.some(item => item.name === "nested-cursor")).toBe(git);
      expect(JSON.stringify(discovered)).not.toContain("PRIVATE SKILL BODY");
      await writeFile(join(dir, `${String(git)}.json`), JSON.stringify({ ...report, discovered, parity: true }, null, 2));
    } finally { await Promise.all([rm(f.root, { recursive: true, force: true }), rm(copy, { recursive: true, force: true })]); }
  });
});

function byPath(a: { path: string }, b: { path: string }): number { return a.path.localeCompare(b.path); }
