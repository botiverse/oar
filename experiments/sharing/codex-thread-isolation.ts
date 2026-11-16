/** Native synthetic-marker observations, not a production sharing policy. */
/* oxlint-disable no-await-in-loop -- Ordered phases distinguish persistence from tool-output echoes. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isolationChildSource } from "./codex-thread-isolation-child.js";
import { codexFixture } from "./codex-fixture.js";
import { directoryConfiguration } from "./directory-configuration.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";

const out = path.resolve(process.argv[2] ?? "oar-trial-run/codex-thread-isolation");
await mkdir(out, { recursive: true });
const markers = ["OAR_SYNTHETIC_THREAD_A_20261116", "OAR_SYNTHETIC_THREAD_B_20261116"];
const tokens = markers.map(marker => `${marker}_TOKEN`);
const needles = [...markers, ...tokens];
const rows: JsonRecord[] = [];
async function scanFiles(root: string): Promise<JsonRecord[]> {
  const found: JsonRecord[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && ["sessions", "shell_snapshots", "log", "logs"].some(name => file === path.join(root, name) || file.startsWith(`${path.join(root, name)}${path.sep}`))) { await visit(file); }
      else if (entry.isFile()) {
        const bytes = await readFile(file); found.push({ file: path.relative(root, file), bytes: bytes.length, markers: needles.filter(marker => bytes.includes(marker)) });
      }
    }
  }
  await visit(root); return found;
}
for (const mode of ["shared-thread", "isolated-thread", "isolated-process"] as const) {
  const row: JsonRecord = { mode, complete: false }; rows.push(row);
  const fixture = await codexFixture();
  try {
    assert.equal(fixture.installation.version, "codex-cli 0.169.0"); row.installation = fixture.installation;
    const codexHome = fixture.provider.env?.CODEX_HOME; assert.ok(codexHome !== undefined && codexHome.length > 0);
    const child = path.join(fixture.home, "isolation-child.cjs");
    await writeFile(child, isolationChildSource);
    await writeFile(path.join(fixture.home, "tool.mjs"), `import ${JSON.stringify(child)};\n`);
    const journal = path.join(fixture.home, "isolation-children.jsonl"); await writeFile(journal, "");
    const pids: number[] = [];
    const saveManifest = async (): Promise<void> => { await writeFile(path.join(fixture.home, "isolation-manifest.json"), JSON.stringify({ codexHome, markers: needles, pids })); };
    await saveManifest();
    const [cwd] = fixture.cwds; assert.ok(cwd !== undefined);
    const hooks = await directoryConfiguration({ runtime: "codex", cwd, home: fixture.home, env: fixture.provider.env });
    await hooks.setRevision("A");
    const hookScript = path.join(fixture.home, "directory-hook.cjs");
    const hookSource = await readFile(hookScript, "utf8");
    await writeFile(hookScript, hookSource.replace("cwd:process.cwd(),event", "cwd:process.cwd(),marker:process.env.OAR_EXECUTION_ENV_MARKER??null,token:process.env.OAR_THREAD_TOKEN??null,event"));
    const launch = (label: number): Readonly<Record<string, string>> => mode === "isolated-process" ? { OAR_EXECUTION_ENV_MARKER: markers[label] ?? "", OAR_THREAD_TOKEN: tokens[label] ?? "" } : {};
    const a = await fixture.connect(launch(0)); const b = mode === "shared-thread" ? a : await fixture.connect(launch(1));
    for (const identity of fixture.processIdentities) { pids.push(identity.selected.pid); }
    await saveManifest();
    const ids: string[] = [];
    for (const [index, client] of [a, b].entries()) {
      const label = index === 0 ? "A" : "B";
      const config = { bypass_hook_trust: true,
        ...(mode === "isolated-process" ? {} : { shell_environment_policy: { set: { OAR_EXECUTION_ENV_MARKER: markers[index], OAR_THREAD_TOKEN: tokens[index] } } }),
        mcp_servers: { scope: { command: process.execPath, args: [child, "mcp", label], env_vars: ["OAR_EXECUTION_ENV_MARKER", "OAR_THREAD_TOKEN"], enabled: true } } };
      const result = await fixture.request(client, "thread/start", { cwd: fixture.cwds[index], model: "gpt-5.1", approvalPolicy: "never", config });
      const id = asRecord(result.thread)?.id; assert.equal(typeof id, "string"); ids.push(String(id));
    }
    row.beforePromptFiles = await scanFiles(codexHome);
    const turns: JsonRecord[] = []; row.turns = turns;
    for (const [index, client] of [a, b].entries()) {
      const id = ids[index]; assert.ok(id !== undefined); const label = index === 0 ? "A" : "B";
      for (const phase of ["mcp", "background"] as const) {
        const result = await fixture.turn(client, id, `${label}_${phase}`); turns.push({ label, phase, result });
        assert.equal(result.status, "completed");
      }
      const childText = await readFile(path.join(fixture.home, `${label}.json`), "utf8");
      const childRecord: unknown = JSON.parse(childText);
      const childPid = asRecord(childRecord)?.parent;
      assert.equal(typeof childPid, "number"); pids.push(Number(childPid)); await saveManifest();
    }
    for (const [index, client] of [a, b].entries()) {
      const id = ids[index]; assert.ok(id !== undefined); const label = index === 0 ? "A" : "B";
      const result = await fixture.turn(client, id, `${label}_cwd`); turns.push({ label, phase: "cross-read", result }); assert.equal(result.status, "completed");
    }
    row.afterPromptFiles = await scanFiles(codexHome);
    const journalText = await readFile(journal, "utf8");
    row.children = journalText.trim().split("\n").filter(Boolean).map((line): unknown => JSON.parse(line));
    row.hooks = await hooks.evidence(); row.complete = true;
  } catch (error) { row.error = String(error); }
  finally {
    row.native = { calls: fixture.calls, events: fixture.events, requests: fixture.seen };
    await writeFile(path.join(out, "evidence.json"), JSON.stringify({ platform: process.platform, markers, tokens, rows }, null, 2));
    await fixture.stop();
  }
}
console.log(JSON.stringify(rows.map(row => ({ mode: row.mode, complete: row.complete, error: row.error }))));
assert.ok(rows.every(row => row.complete === true), "incomplete native evidence retained");
