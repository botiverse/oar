/* oxlint-disable max-statements, max-lines-per-function -- Compare native and public catalogs inside one owned fixture. */
import assert from "node:assert/strict";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { dshRuntime } from "../../packages/oar/src/runtimes/dsh/index.js";
import { nativeRows } from "../../packages/oar/src/shared/inventory.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { withNativeProbe } from "../../experiments/dsh-option-boundaries/native-probe.js";
import { dshEnabled, withDshFixture, say } from "./support/dsh-fixture.js";
import { dshSkillProvider, populateDshSkills } from "./support/dsh-skills-fixture.js";

const source = 'async nativeSkills(request) { return await ctx.get("skills").snapshot({ cwd: request.cwd }); },';

describe.skipIf(!dshEnabled)("DSH native skill discovery", () => {
  test("matches the complete native profile catalog, invocation flags and source without creating a session", { timeout: 60_000 }, async () => {
    await withDshFixture(() => say("unexpected inference"), async f => {
      assert.ok(f.installation.via === "executable");
      const version = f.installation.version;
      const env = await populateDshSkills(f);
      const configFile = path.join(f.aimock.home, "cordis.patch.yml");
      const before = await readFile(configFile, "utf8");
      const nativeFixture = { ...f, aimock: { ...f.aimock, env } };
      await withNativeProbe(nativeFixture, { source, rows: [] }, async (control, frames) => {
        const native = await control.request("nativeSkills", { cwd: f.aimock.cwd });
        const rows = nativeRows(native.skills);
        expect(rows.map(row => row.name)).toEqual(expect.arrayContaining(["bundled-fixture", "project-agents", "project-dsh", "user-agents", "user-dsh"]));
        expect(native.complete).toBe(true);
        const result = await dshRuntime.skills(f.installation, { cwd: f.aimock.cwd, env });
        assert.equal(result.kind, "ok", JSON.stringify(result));
        expect(result.items).toEqual(rows.map(row => ({ name: row.name, description: row.description, path: row.path, source: row.source,
          scope: row.source === "bundled" ? "builtin" : (String(row.source).startsWith("user-") ? "user" : "project"),
          disableModelInvocation: asRecord(row.invocation)?.modelInvocable === false })));
        expect(result.partial).toBe(false);
        expect(result.view).toBe("discovered");
        expect(JSON.stringify(result)).not.toContain("PRIVATE");
        expect(frames.some(frame => frame.channel === "session/event")).toBe(false);
        expect(f.provider.requests).toHaveLength(0);
        expect(await readFile(configFile, "utf8")).toBe(before);
        const files = await readdir(f.aimock.home, { recursive: true });
        expect(files.some(file => /\.jsonl(?:\.zst)?$|\.jsonl\.gz$/u.test(file))).toBe(false);
        const directory = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "dsh-skills");
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "catalog.json"), JSON.stringify({ version, native, result, files, providerRequests: 0, configUnchanged: true }, null, 2)
          .replaceAll(path.dirname(f.aimock.home), "<fixture>"));
      });
    });
  });

  test.each(["failure", "hang"] as const)("a native provider %s remains partial or times out", { timeout: 60_000 }, async mode => {
    await withDshFixture(() => say("unexpected inference"), async f => {
      const env = await populateDshSkills(f);
      const config = path.join(f.aimock.home, "cordis.patch.yml");
      const rows = nativeRows(parseJson(await readFile(config, "utf8")));
      await writeFile(config, JSON.stringify([...rows, ...await dshSkillProvider(f, mode)]));
      const result = await dshRuntime.skills(f.installation, { cwd: f.aimock.cwd, env, timeoutMs: 15_000 });
      const pid = Number(await readFile(path.join(f.aimock.home, "provider-entered"), "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
      if (mode === "failure") {
        assert.equal(result.kind, "ok");
        expect(result.partial).toBe(true);
        await withNativeProbe({ ...f, aimock: { ...f.aimock, env } }, { source, rows: [] }, async control => {
          const native = await control.request("nativeSkills", { cwd: f.aimock.cwd });
          expect(native.complete).toBe(false);
          const skills = nativeRows(native.skills);
          expect(skills.map(row => row.name)).toEqual(expect.arrayContaining(["bundled-fixture", "project-agents", "project-dsh", "user-agents", "user-dsh"]));
          expect(result.items).toEqual(skills.map(row => ({ name: row.name, description: row.description, path: row.path, source: row.source,
            scope: row.source === "bundled" ? "builtin" : (String(row.source).startsWith("user-") ? "user" : "project"),
            disableModelInvocation: asRecord(row.invocation)?.modelInvocable === false })));
          const directory = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "dsh-skills");
          await mkdir(directory, { recursive: true });
          await writeFile(path.join(directory, "partial.json"), JSON.stringify({ native, result, processExited: true, providerRequests: 0 }, null, 2)
            .replaceAll(path.dirname(f.aimock.home), "<fixture>"));
        });
      }
      else { expect(result).toMatchObject({ kind: "unavailable", code: "timeout" }); }
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      expect(f.provider.requests).toHaveLength(0);
    });
  });
});
