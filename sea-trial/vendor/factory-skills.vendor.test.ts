/* oxlint-disable max-statements, max-lines-per-function -- One isolated native fixture checks both the catalog and startup effects. */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { factoryRuntime } from "../../packages/oar/src/runtimes/factory/index.js";
import { startDroidClient } from "../../packages/oar/src/runtimes/factory/client.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { nativeRows } from "../../packages/oar/src/shared/inventory.js";
import { startFactoryAimock } from "../harness/factory-aimock.js";
import { expectAvailable } from "./support/asserts.js";

test.skipIf(process.env.OAR_TEST !== "factory-aimock")("Factory native skill metadata needs no session and retains disabled and hidden skills", { timeout: 60_000 }, async () => {
  const provider = await startFactoryAimock();
  const home = provider.env.HOME;
  assert.ok(home !== undefined);
  const allowed = { ...provider.env, PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" };
  const env = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])), ...allowed };
  const installation = await factoryRuntime.installation();
  expectAvailable(installation, "Factory");
  assert.equal(installation.via, "executable");
  const config = join(home, ".factory/settings.json");
  const settings = asRecord(JSON.parse(await readFile(config, "utf8")));
  assert.ok(settings);
  const configText = JSON.stringify({ ...settings, disabledSkills: ["oar-user"] });
  await writeFile(config, configText);
  for (const [base, name, flags] of [[home, "oar-user", ""], [provider.cwd, "oar-project", ""], [provider.cwd, "oar-hidden", "user-invocable: false\n"], [provider.cwd, "oar-manual", "disable-model-invocation: true\n"]] as const) {
    const dir = join(base, ".factory/skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Synthetic ${name}\n${flags}---\nPRIVATE SKILL BODY\n!\`touch OAR_SKILL_BODY_EXECUTED\`\n`);
  }
  try {
    const result = await factoryRuntime.skills(installation, { cwd: provider.cwd, env });
    assert.equal(result.kind, "ok", JSON.stringify(result));
    expect(result.view).toBe("discovered");
    expect(result.partial).toBe(false);
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "oar-user", scope: "user", source: "personal", enabled: false }),
      expect.objectContaining({ name: "oar-project", scope: "project", source: "project", enabled: true }),
      expect.objectContaining({ name: "oar-hidden", scope: "project", enabled: true }),
      expect.objectContaining({ name: "oar-manual", scope: "project", enabled: true }),
    ]));
    expect(result.items.some(item => item.scope === "builtin")).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE SKILL BODY|disableModelInvocation/u);
    expect(await readFile(config, "utf8")).toBe(configText);
    const files = await readdir(home, { recursive: true });
    expect(files.some(file => /sessions[/\\]|index\.db|auth\.json|OAR_SKILL_BODY_EXECUTED/u.test(file))).toBe(false);
    expect(provider.mock.getRequests()).toHaveLength(0);
    const native = startDroidClient(installation.command, { cwd: provider.cwd, env: allowed });
    native.handle({ onNotification: () => {}, onUnmatched: () => {}, onServerRequest: message => { native.respond(message.id, { error: { code: -32_601, message: "Not handled" } }); } });
    try {
      const before = await native.request("droid.list_skills", { includeContent: false });
      expect(before.projectAvailable).toBe(true);
      const rows = nativeRows(before.skills);
      expect(rows.some(row => row.content !== undefined || row.resources !== undefined)).toBe(false);
      const scopes: Readonly<Record<string, string>> = { personal: "user", project: "project", builtin: "builtin", automation: "other" };
      expect(result.items).toEqual(rows.map(row => ({ name: row.name, description: row.description, path: row.filePath, source: row.location, scope: typeof row.location === "string" ? scopes[row.location] : undefined, plugin: row.pluginId, enabled: row.enabled })));
      await native.request("droid.initialize_session", { cwd: provider.cwd, machineId: "oar-synthetic-skills" });
      const after = await native.request("droid.list_skills", { includeContent: false });
      expect(after).toEqual(before);
      expect(provider.mock.getRequests()).toHaveLength(0);
      const output = resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "factory-skills");
      await mkdir(output, { recursive: true });
      await writeFile(join(output, "result.json"), JSON.stringify({ installationVersion: installation.version, native: before, result, queryCreatedNoSession: true, configUnchanged: true, providerRequests: 0, preinitEqualsPostinit: true, queryFiles: files }, null, 2).replaceAll(home, "<fixture>"));
    } finally { native.kill(); await native.exited; }
  } finally { await provider.stop(); }
});
