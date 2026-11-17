/* oxlint-disable max-statements, max-lines-per-function -- One isolated fixture compares the native catalog, public projection and side effects. */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { qwenRuntime } from "../../packages/oar/src/runtimes/qwen/index.js";
import { createAcpClient, methods, startAcpProcess, withAcpDeadline } from "../../packages/oar/src/shared/acp/process.js";
import { sessionEnvironment } from "../../packages/oar/src/shared/environment.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { nativeRows } from "../../packages/oar/src/shared/inventory.js";
import { startQwenAimock } from "../harness/qwen-aimock.js";

async function skill(base: string, name: string, description: string, flags = ""): Promise<string> {
  const directory = path.join(base, name);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "SKILL.md");
  await writeFile(file, `---\nname: ${name}\ndescription: ${description}\n${flags}---\nPRIVATE_SKILL_BODY\n`);
  return file;
}
async function native(command: string, cwd: string, env: Readonly<Record<string, string | null>>): Promise<{ catalog: JsonRecord; calls: string[] }> {
  const calls: string[] = [];
  const child = startAcpProcess(command, ["--acp"], createAcpClient({ name: "oar-skills-parity" }), {
    cwd, env: sessionEnvironment(env), inheritStderr: false,
    outgoing: message => { if ("method" in message) { calls.push(message.method); } },
  });
  try {
    await withAcpDeadline(child, "initialize", 30_000, async send => child.connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} }, send));
    const catalog = asRecord(await withAcpDeadline(child, "skills", 30_000, async send => child.connection.agent.request("qwen/status/workspace/skills", {}, send)));
    assert.ok(catalog);
    return { catalog, calls };
  } finally { child.kill(); await child.exited; }
}

describe.skipIf(process.env.OAR_TEST !== "qwen-aimock")("Qwen native workspace skills", () => {
  test("unsigned ACP metadata matches OAR, including disabled, hidden, bundled, user and project skills", { timeout: 90_000 }, async () => {
    const f = await startQwenAimock();
    try {
      const home = path.dirname(f.cwd);
      await mkdir(path.join(f.cwd, ".git"));
      const files = [
        await skill(path.join(home, ".qwen/skills"), "user-marker", "User metadata"),
        await skill(path.join(home, ".agents/skills"), "user-compat", "User compatibility metadata"),
        await skill(path.join(home, ".qwen/skills"), "precedence", "User loses"),
        await skill(path.join(f.cwd, ".qwen/skills"), "precedence", "Project wins"),
        await skill(path.join(f.cwd, ".agents/skills"), "project-compat", "Project compatibility metadata"),
        await skill(path.join(f.cwd, ".qwen/skills"), "disabled-marker", "Disabled metadata"),
        await skill(path.join(f.cwd, ".qwen/skills"), "hidden-marker", "Hidden metadata", "user-invocable: false\n"),
        await skill(path.join(f.cwd, ".qwen/skills"), "no-model-marker", "Manual metadata", "disable-model-invocation: true\n"),
      ];
      const config = path.join(home, ".qwen/settings.json");
      const settings = asRecord(JSON.parse(await readFile(config, "utf8")));
      // Keep the local request trap, but remove authentication configuration and every inherited credential.
      await writeFile(config, JSON.stringify({ ...settings, security: { auth: {} }, skills: { disabled: ["disabled-marker"] } }));
      const env = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])), ...f.env, OPENAI_API_KEY: null, PATH: process.env.PATH ?? "",
        QWEN_HOME: null, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9" };
      const installation = await qwenRuntime.installation();
      assert.equal(installation.kind, "available"); assert.equal(installation.via, "executable");
      const before = await readFile(config, "utf8");
      const contents = await Promise.all(files.map(async file => readFile(file, "utf8")));
      const { catalog, calls } = await native(installation.command, f.cwd, env);
      const afterNative = await readFile(config, "utf8");
      const migrated = asRecord(JSON.parse(afterNative));
      expect(migrated).toEqual({ ...asRecord(JSON.parse(before)), $version: 4 });
      assert.equal(catalog.initialized, true);
      const rows = nativeRows(catalog.skills);
      const result = await qwenRuntime.skills(installation, { cwd: f.cwd, env, timeoutMs: 30_000 });
      assert.equal(result.kind, "ok", JSON.stringify(result));
      const scopes: Record<string, string> = { bundled: "builtin", project: "project", user: "user", extension: "other" };
      expect(result.items).toEqual(rows.map(row => ({ name: row.name, description: row.description, path: row.installedPath, source: row.level,
        ...(typeof row.level === "string" && scopes[row.level] !== undefined ? { scope: scopes[row.level] } : {}),
        ...(row.extensionName === undefined ? {} : { plugin: row.extensionName }), enabled: row.status === "ok", disableModelInvocation: row.modelInvocable === false })));
      expect(result.partial).toBe(false);
      expect(result.view).toBe("discovered");
      expect(result.items.map(row => row.name)).toEqual(expect.arrayContaining(["user-marker", "user-compat", "project-compat", "hidden-marker", "disabled-marker", "no-model-marker"]));
      expect(result.items.filter(row => row.name === "precedence")).toEqual([expect.objectContaining({ description: "Project wins", scope: "project" })]);
      expect(result.items.find(row => row.name === "disabled-marker")).toMatchObject({ enabled: false });
      expect(result.items.find(row => row.name === "no-model-marker")).toMatchObject({ disableModelInvocation: true });
      expect(result.items.some(row => row.scope === "builtin")).toBe(true);
      expect(rows.find(row => row.name === "hidden-marker")?.userInvocable).toBe(false);
      for (const [name, file] of [["user-marker", files[0]], ["precedence", files[3]]] as const) {
        assert.ok(file !== undefined); const reported: string | undefined = result.items.find(row => row.name === name)?.path; assert.ok(reported !== undefined);
        expect(await realpath(reported)).toBe(await realpath(file));
      }
      expect(calls).toEqual(["initialize", "qwen/status/workspace/skills"]);
      expect(f.raw).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_SKILL_BODY");
      expect(await readFile(config, "utf8")).toBe(afterNative);
      expect(await Promise.all(files.map(async file => readFile(file, "utf8")))).toEqual(contents);
      const afterFiles = await readdir(home, { recursive: true });
      expect(afterFiles.filter(file => /\.jsonl(?:\.gz)?$|session-.*\.json$/u.test(file))).toEqual([]);
      const directory = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "qwen-skills");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "catalog.json"), JSON.stringify({ version: installation.version, catalog, result, calls, afterFiles,
        providerRequests: f.raw.length, nativeSettingsMigration: 4, warmConfigUnchanged: true, skillBodiesUnchanged: true }, null, 2).replaceAll(home, "<fixture>"));
    } finally { await f.stop(); }
  });
});
