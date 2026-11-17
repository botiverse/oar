/* oxlint-disable max-statements, max-lines-per-function -- Compare the native catalog and public reader in one isolated fixture. */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { devinRuntime } from "../../packages/oar/src/runtimes/devin/index.js";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";
import { parseJson } from "../../packages/oar/src/shared/json.js";
import { nativeRows } from "../../packages/oar/src/shared/inventory.js";
import { devinSkillsFixture, populateDevinSkills } from "./support/devin-skills-fixture.js";

describe.skipIf(process.env.OAR_TEST !== "devin-skills")("Devin native skill catalog", () => {
  test("empty home, builtin metadata, user/project roots and malformed-file omission", { timeout: 60_000 }, async () => {
    const command = process.env.OAR_DEVIN_BIN;
    assert.ok(command !== undefined && command !== "", "OAR_DEVIN_BIN must select the measured native executable");
    const f = await devinSkillsFixture();
    const output = resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "devin-skills");
    try {
      const version = await runExecutable(command, ["--version"], { cwd: f.cwd, env: f.env });
      assert.ok(version.ok);
      expect(version.stdout.trim()).toBe("devin 3000.12.57 (96542e930752)");
      const empty = await runExecutable(command, ["skills", "list", "--json"], { cwd: f.cwd, env: f.env });
      assert.ok(empty.ok);
      const builtins = nativeRows(parseJson(empty.stdout));
      expect(builtins.map(row => String(row.name)).toSorted((a, b) => a.localeCompare(b))).toEqual(["declarative-repo-setup", "devin-cli", "upload-secrets"]);
      expect(builtins.every(row => row.provider === "Builtin")).toBe(true);
      await populateDevinSkills(f);
      const native = await runExecutable(command, ["skills", "list", "--json"], { cwd: f.cwd, env: f.env });
      assert.ok(native.ok);
      const rows = nativeRows(parseJson(native.stdout));
      expect(rows).toHaveLength(11);
      expect(rows.some(row => row.name === "broken-yaml")).toBe(false);
      expect(rows.every(row => JSON.stringify(row.errors) === "[]" && JSON.stringify(row.warnings) === "[]")).toBe(true);
      const removed = Object.fromEntries(Object.keys(process.env).map(key => [key, null]));
      const allowed = Object.fromEntries(Object.entries(f.env).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
      const discovered = await devinRuntime.skills({ kind: "available", via: "executable", command }, { cwd: f.cwd, env: { ...removed, ...allowed } });
      assert.equal(discovered.kind, "ok", JSON.stringify(discovered));
      const expected = rows.map(row => {
        assert.ok(Array.isArray(row.triggers));
        return { name: row.name, description: row.description, source: row.provider, path: row.base_dir === "" ? undefined : row.base_dir, scope: row.provider === "Builtin" ? "builtin" : undefined, disableModelInvocation: !row.triggers.includes("model") };
      });
      expect(discovered.items).toEqual(expected);
      expect(discovered.view).toBe("discovered");
      expect(discovered.partial).toBe(true);
      expect(discovered.items.filter(item => item.scope === "builtin")).toHaveLength(3);
      expect(discovered.items.filter(item => item.source === "Devin" && item.scope === undefined)).toHaveLength(4);
      expect(JSON.stringify(discovered)).not.toContain("PRIVATE SKILL BODY");
      expect(await readFile(f.config, "utf8")).toBe(f.configText);
      const files = await readdir(f.root, { recursive: true });
      expect(files.some(file => /sessions\.db|credentials\.toml|OAR_SKILL_BODY_EXECUTED/u.test(file))).toBe(false);
      await mkdir(output, { recursive: true });
      const report = { version: version.stdout.trim(), native: rows, discovered, configUnchanged: true, noSessionOrCredentialFile: true, bodyNotExecuted: true, files, nativeStderr: native.stderr };
      await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2).replaceAll(f.root, "<fixture>"));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
