/** Kimi native workspace indexes do not remain shared through a file symlink. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { kimiRuntime, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { startKimiAimock } from "../../sea-trial/harness/aimock-acp.js";

async function completed(session: Session): Promise<void> {
  try {
    const turn = await promptAndWait(session, "history probe", { timeoutMs: 30_000 });
    assert.ok(turn.kind === "ended" && turn.outcome.kind === "completed");
  } finally { await session.dispose(); }
}

async function attempt(open: Promise<Session>): Promise<string> {
  try { const session = await open; await session.dispose(); return "opened"; }
  catch (error) { assert.ok(error instanceof Error); return error.name; }
}

async function linkHistory(original: string, isolated: string): Promise<void> {
  await Promise.all(["sessions", "session_index.jsonl", "workspaces.json"].map(async (name) => {
    await rm(path.join(isolated, name), { recursive: true, force: true });
    await symlink(path.join(original, name), path.join(isolated, name), name === "sessions" ? "junction" : "file");
  }));
}

const fixture = await startKimiAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); });
const root = await mkdtemp(path.join(tmpdir(), "oar-kimi-config-probe-"));
try {
  const installation = await kimiRuntime.installation();
  assert.ok(installation.kind === "available" && installation.via === "executable");
  const original = fixture.env.KIMI_CODE_HOME;
  assert.ok(original !== undefined && original !== "");
  const isolated = path.join(root, "private");
  await mkdir(isolated);
  await Promise.all(["credentials", "oauth"].map(async (name) => {
    await mkdir(path.join(original, name), { recursive: true });
    await symlink(path.join(original, name), path.join(isolated, name), "junction");
  }));
  const deviceId = "00000000-0000-4000-8000-000000000001";
  await writeFile(path.join(original, "device_id"), deviceId);
  await writeFile(path.join(isolated, "device_id"), deviceId);
  const common = { cwd: root, env: fixture.env };
  const first = await kimiRuntime.session(installation, common);
  const { id } = first;
  await completed(first);
  const shared = { ...common, env: { ...fixture.env, KIMI_CODE_HOME: isolated } };
  const authOnly = await attempt(kimiRuntime.session(installation, { ...shared, resume: id }));
  assert.equal(authOnly, "SessionNotFoundError");
  await linkHistory(original, isolated);
  assert.equal(await attempt(kimiRuntime.session(installation, { ...shared, resume: id })), "opened");
  const secondProject = path.join(root, "another-project");
  await mkdir(secondProject);
  const created = await kimiRuntime.session(installation, { ...shared, cwd: secondProject });
  const privateId = created.id;
  await completed(created);
  const originalWorkspace = await readFile(path.join(original, "workspaces.json"), "utf8");
  const privateWorkspace = await readFile(path.join(isolated, "workspaces.json"), "utf8");
  const index = await readFile(path.join(original, "session_index.jsonl"), "utf8");
  const stat = await lstat(path.join(isolated, "workspaces.json"));
  assert.equal(stat.isSymbolicLink(), false);
  const projectText = JSON.stringify(secondProject).slice(1, -1);
  assert.equal(originalWorkspace.includes(projectText), false);
  assert.equal(privateWorkspace.includes(projectText), true);
  assert.equal(index.includes(JSON.stringify(isolated).slice(1, -1)), true);
  await rm(isolated, { recursive: true, force: true });
  const after = await attempt(kimiRuntime.session(installation, { ...common, cwd: secondProject, resume: privateId }));
  assert.equal(after, "opened");
  assert.equal(await attempt(kimiRuntime.session(installation, { ...common, resume: id })), "opened");
  assert.equal(await readFile(path.join(original, "device_id"), "utf8"), deviceId);
  console.log(JSON.stringify({ runtime: "kimi", version: installation.version, authOnlyResume: authOnly, sharedHistoryResume: "opened", workspaceLinkReplaced: true, newWorkspaceMissingFromOriginalCatalog: true, historyIndexContainsTemporaryPath: true, explicitCwdAndIdResumeAfterCleanup: after, originalSessionAndDeviceIdIntact: true }));
} finally {
  await fixture.stop();
  await rm(root, { recursive: true, force: true });
}
