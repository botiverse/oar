/* oxlint-disable max-statements, max-lines-per-function, import/max-dependencies -- Native catalog, disk history and model-request observations share one isolated fixture. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { antigravityRuntime } from "../../packages/oar/src/runtimes/antigravity/index.js";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { nativeRows } from "../../packages/oar/src/shared/inventory.js";
import { startAntigravityAimock } from "../harness/aimock-acp.js";

async function skill(dir: string, name: string, flags = ""): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Synthetic ${name} metadata\n${flags}---\nPRIVATE SKILL BODY\n!\`touch OAR_SKILL_BODY_EXECUTED\`\n`);
}
function overlay(env: NodeJS.ProcessEnv): Record<string, string | null> {
  return { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])), ...Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) };
}
async function fixture(): Promise<Awaited<ReturnType<typeof startAntigravityAimock>> & { home: string; cwd: string; nativeEnv: NodeJS.ProcessEnv }> {
  const f = await startAntigravityAimock(() => {});
  const home = f.env.HOME; assert.ok(home !== undefined);
  const cwd = join(home, "project"); await mkdir(cwd);
  const nativeEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...f.env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(home, "no-bus")}`, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" };
  return { ...f, home, cwd, nativeEnv };
}

describe.skipIf(process.env.OAR_TEST !== "antigravity-aimock")("Antigravity native skill query", () => {
  test("native metadata, plugin identity and invocation flags without a saved conversation", { timeout: 60_000 }, async () => {
    const installation = await antigravityRuntime.installation(); assert.equal(installation.kind, "available"); assert.equal(installation.via, "executable");
    const f = await fixture();
    let queryEvidence: unknown = null;
    try {
      const config = join(f.home, ".gemini/antigravity-cli/settings.json"); const beforeConfig = await readFile(config, "utf8");
      const beforeBinary = createHash("sha256").update(await readFile(installation.command)).digest("hex");
      await skill(join(f.cwd, ".agents/skills/workspace"), "oar-workspace");
      await skill(join(f.home, ".gemini/skills/shared"), "oar-shared");
      await skill(join(f.home, ".gemini/config/skills/personal"), "oar-personal");
      await skill(join(f.home, ".gemini/antigravity-cli/skills/cli"), "oar-cli");
      await skill(join(f.cwd, ".agents/skills/manual"), "oar-manual", "disable-model-invocation: true\n");
      await skill(join(f.cwd, ".agents/skills/hidden"), "oar-hidden", "disable-slash-command: true\n");
      const plugin = join(f.home, ".gemini/config/plugins/oar-plugin"); await mkdir(plugin, { recursive: true });
      await writeFile(join(plugin, "plugin.json"), JSON.stringify({ name: "oar-plugin", description: "Synthetic plugin", version: "1.0.0" }));
      await skill(join(plugin, "skills/child"), "child");
      const native = await runExecutable(installation.command, ["--output-format", "json", "--print=/skills"], { cwd: f.cwd, env: f.nativeEnv });
      queryEvidence = { ok: native.ok, stdout: native.stdout.slice(0, 65_536), stderr: native.stderr.slice(0, 65_536),
        stdoutTruncated: native.stdout.length > 65_536, stderrTruncated: native.stderr.length > 65_536 };
      assert.ok(native.ok, JSON.stringify(native));
      const reply = asRecord(parseJson(native.stdout)); const rows = nativeRows(asRecord(asRecord(reply?.command)?.data)?.skills);
      expect(reply).toMatchObject({ status: "SUCCESS", conversation_id: "", num_turns: 0 });
      expect(rows.map(row => row.name)).toEqual(expect.arrayContaining(["oar-workspace", "oar-shared", "oar-personal", "oar-cli", "oar-manual", "oar-plugin:child"]));
      expect(rows.some(row => row.builtin === true)).toBe(true);
      expect(rows.some(row => row.name === "oar-hidden")).toBe(false);
      const result = await antigravityRuntime.skills(installation, { cwd: f.cwd, env: overlay({ ...f.nativeEnv, AGY_CLI_DISABLE_AUTO_UPDATE: "false" }) });
      assert.equal(result.kind, "ok", JSON.stringify(result));
      expect(result.items).toEqual(rows.map(row => ({ name: row.name, description: row.description, path: row.path,
        ...(row.plugin === undefined ? {} : { plugin: row.plugin }), ...(row.builtin === true ? { scope: "builtin" } : {}), disableModelInvocation: row.model_invocable === false })));
      expect(result.items.find(row => row.name === "oar-manual")?.disableModelInvocation).toBe(true);
      expect(result.partial).toBe(false); expect(result.view).toBe("discovered");
      expect(JSON.stringify(result)).not.toContain("PRIVATE SKILL BODY");
      expect(f.raw).toHaveLength(0);
      expect(createHash("sha256").update(await readFile(installation.command)).digest("hex")).toBe(beforeBinary);
      const afterConfig = await readFile(config, "utf8");
      expect(parseJson(afterConfig)).toEqual(parseJson(beforeConfig));
      const db = new DatabaseSync(join(f.home, ".gemini/antigravity-cli/conversation_summaries.db"), { readOnly: true });
      let conversations: unknown = null;
      try { conversations = db.prepare("SELECT count(*) AS count FROM conversation_summaries").get()?.count; } finally { db.close(); }
      expect(conversations).toBe(0);
      const files = await readdir(f.home, { recursive: true });
      expect(files.some(file => /OAR_SKILL_BODY_EXECUTED|oauth|credential/u.test(file))).toBe(false);
      expect(files.some(file => /(?:^|[/\\])conversations[/\\]/u.test(file))).toBe(false);
      const output = resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "antigravity-skills", "catalog.json");
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify({ version: installation.version, native: rows, result, conversations, modelRequests: f.raw.length, configValuesUnchanged: true, configBytesChanged: afterConfig !== beforeConfig, binaryUnchanged: true, files }, null, 2).replaceAll(f.home, "<home>"));
    } finally {
      try {
        const output = resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "antigravity-skills", "query-attempt.json");
        await mkdir(dirname(output), { recursive: true });
        const files = await readdir(f.home, { recursive: true });
        await writeFile(output, JSON.stringify({ version: installation.version, query: queryEvidence, files, modelRequests: f.raw.length }, null, 2)
          .replaceAll(f.home, "<home>").replaceAll(JSON.stringify(f.home).slice(1, -1), "<home>"));
      } catch (error) {
        console.error("Antigravity skill evidence could not be saved:", error instanceof Error ? error.name : "unknown");
      } finally { await f.stop(); }
    }
  });

  test("signed-out discovery follows the versioned reader without saving a conversation", { timeout: 30_000 }, async () => {
    const installation = await antigravityRuntime.installation(); assert.equal(installation.kind, "available"); assert.equal(installation.via, "executable");
    const f = await fixture();
    try {
      await rm(join(f.home, ".gemini"), { recursive: true, force: true });
      const env = overlay(f.nativeEnv); delete env.GEMINI_API_KEY; env.GEMINI_API_KEY = null;
      const result = await antigravityRuntime.skills(installation, { cwd: f.cwd, env });
      const local = (process.platform === "linux" || process.platform === "darwin") && (installation.version === "1.5.10" || installation.version === "1.5.11");
      if (local) { expect(result).toMatchObject({ kind: "ok", view: "discovered", partial: true, items: [] }); }
      else { expect(result).toEqual({ kind: "unavailable", code: "not_authenticated", reason: "Sign in to Antigravity to read its skills." }); }
      expect(f.raw).toHaveLength(0);
      const files = await readdir(f.home, { recursive: true });
      expect(files.filter(file => /(?:^|[/\\])conversations[/\\]|oauth|credential/u.test(file))).toEqual([]);
      if (local) { expect(files).toEqual(["project"]); }
      else {
        const db = new DatabaseSync(join(f.home, ".gemini/antigravity-cli/conversation_summaries.db"), { readOnly: true });
        try { expect(db.prepare("SELECT count(*) AS count FROM conversation_summaries").get()?.count).toBe(0); } finally { db.close(); }
      }
      const output = resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "antigravity-skills", "signed-out.json");
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify({ result, files, modelRequests: f.raw.length }, null, 2));
    } finally { await f.stop(); }
  });
});
