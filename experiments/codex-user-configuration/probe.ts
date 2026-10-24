/** Native Codex history across temporary homes. Local provider and synthetic credentials only. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, writeFile, rm, symlink, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexInstallation, codexSession, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startAppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { startCodexAimock } from "../../sea-trial/harness/aimock.js";

async function completed(session: Session): Promise<void> {
  try {
    const turn = await promptAndWait(session, "history probe", { timeoutMs: 30_000 });
    assert.equal(turn.kind, "ended");
    assert.equal(turn.outcome.kind, "completed");
  } finally { await session.dispose(); }
}

async function attempt(open: Promise<Session>): Promise<string> {
  try { const session = await open; await session.dispose(); return "opened"; }
  catch (error) { assert.ok(error instanceof Error); return error.name; }
}

async function listedPath(command: string, env: Readonly<Record<string, string | null>>, id: string): Promise<string> {
  const client = startAppServerClient(command, env);
  try {
    await client.request("initialize", { clientInfo: { name: "oar-probe", version: "0.0.0" }, capabilities: { experimentalApi: true } });
    client.notify("initialized", {});
    const response = await client.request("thread/list", { limit: 100, sourceKinds: [], modelProviders: [] });
    assert.ok(Array.isArray(response.data));
    const entries: unknown[] = response.data;
    const entry = entries.map((value) => asRecord(value)).find((candidate) => candidate?.id === id);
    assert.ok(entry !== undefined && entry !== null && typeof entry.path === "string");
    return entry.path;
  } finally { client.kill(); await client.exited; }
}

async function indexedPath(home: string, id: string): Promise<string> {
  const names = await readdir(home);
  const name = names.find((candidate) => /^state_.*\.sqlite$/u.test(candidate));
  assert.ok(name !== undefined);
  const db = new DatabaseSync(path.join(home, name), { readOnly: true });
  try {
    const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(id);
    assert.ok(row !== undefined && typeof row.rollout_path === "string");
    return row.rollout_path;
  } finally { db.close(); }
}

const root = await mkdtemp(path.join(tmpdir(), "oar-codex-config-probe-"));
const fixture = await startCodexAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); }, { warmHome: false });
try {
  const originalHome = fixture.env?.CODEX_HOME;
  assert.ok(originalHome !== undefined && originalHome !== "");
  const privateHome = await mkdtemp(path.join(root, "private-"));
  const credentials = path.join(originalHome, "auth.json");
  const credentialText = JSON.stringify({ OPENAI_API_KEY: "aimock" });
  await writeFile(credentials, credentialText);
  await symlink(credentials, path.join(privateHome, "auth.json"));
  await writeFile(path.join(privateHome, "config.toml"), await readFile(path.join(originalHome, "config.toml")));
  const installation = await codexInstallation();
  assert.ok(installation.kind === "available" && installation.via === "executable");
  const common = { cwd: root, env: { ...fixture.env, HOME: root, USERPROFILE: root, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" } };
  const initial = await codexSession(installation, common);
  const { id } = initial;
  await completed(initial);
  assert.equal(await attempt(codexSession(installation, { ...common, resume: id })), "opened");
  const isolated = { ...common, env: { ...common.env, CODEX_HOME: privateHome } };
  const authOnly = await attempt(codexSession(installation, { ...isolated, resume: id }));
  assert.equal(authOnly, "SessionNotFoundError");
  await symlink(path.join(originalHome, "sessions"), path.join(privateHome, "sessions"), "junction");
  assert.equal(await attempt(codexSession(installation, { ...isolated, resume: id })), "opened");
  const created = await codexSession(installation, { ...isolated, env: { ...isolated.env, CODEX_SQLITE_HOME: originalHome } });
  const privateId = created.id;
  await completed(created);
  const listed = await listedPath(installation.command, common.env, privateId);
  const resolved = await realpath(listed);
  assert.ok(resolved.startsWith(originalHome));
  await rm(privateHome, { recursive: true, force: true });
  const indexed = await indexedPath(originalHome, privateId);
  assert.ok(indexed.startsWith(privateHome));
  const preserved = await readFile(resolved, "utf8");
  assert.ok(preserved.length > 0);
  const resumed = await attempt(codexSession(installation, { ...common, resume: privateId }));
  assert.equal(resumed, "SessionNotFoundError");
  assert.equal(await readFile(credentials, "utf8"), credentialText);
  assert.equal(await attempt(codexSession(installation, { ...common, resume: id })), "opened");
  console.log(JSON.stringify({ runtime: "codex", version: installation.version, authOnlyResume: authOnly, sharedSessionsResume: "opened", createdVisibleInOriginalHistory: true, listedPathIsTemporary: listed.startsWith(privateHome), indexedPathIsTemporary: true, originalHistoryFilePreserved: true, resumeAfterCleanup: resumed, originalSessionAndCredentialsIntact: true }));
} finally {
  await fixture.stop();
  await rm(root, { recursive: true, force: true });
}
