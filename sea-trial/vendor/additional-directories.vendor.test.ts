import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { claudeInstallation, claudeSession, codexInstallation, codexSession, kimiInstallation, kimiSession, type Session } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock, startCodexAimock } from "../harness/aimock.js";
import { startKimiAimock } from "../harness/aimock-acp.js";
import { runTurn } from "./support/asserts.js";

async function directories(): Promise<{ root: string; cwd: string; first: string; second: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "oar-directories-"));
  const cwd = path.join(root, "primary");
  const first = path.join(root, "first extra");
  const second = path.join(root, "second extra");
  await Promise.all([cwd, first, second].map(async (dir) => { await mkdir(dir); }));
  return { root, cwd, first, second };
}

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("Claude includes additional directories in native context on new and resumed sessions", async () => {
  const { root, cwd, first, second } = await directories();
  const provider = await startClaudeAimock(undefined, { captureRaw: true });
  let session: Session | undefined = undefined;
  try {
    const installation = await claudeInstallation();
    if (installation.kind !== "available") { throw new Error("Claude unavailable"); }
    const env = { ...provider.env, CLAUDE_CONFIG_DIR: path.join(root, "config"), ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null };
    session = await claudeSession(installation, { cwd, env, additionalDirectories: ["../first extra"] });
    expect(await runTurn(session, "Say ok")).toEqual({ kind: "completed" });
    expect(JSON.stringify(provider.raw.at(-1)?.body)).toContain(first);
    const id = session.id;
    await session.dispose();
    session = await claudeSession(installation, { cwd, env, resume: id, additionalDirectories: [second] });
    expect(await runTurn(session, "Say ok again")).toEqual({ kind: "completed" });
    expect(JSON.stringify(provider.raw.at(-1)?.body)).toContain(second);
  } finally { await session?.dispose(); await provider.stop(); await rm(root, { recursive: true, force: true }); }
}, 120_000);

/** The native reply already recorded at open, including the applied sandbox. */
function codexOpen(session: Session): Record<string, unknown> | null {
  const record = session.records().find((item) => item.kind === "frame" && ["thread/start", "thread/resume"].includes(item.body.type));
  return record?.kind === "frame" ? asRecord(record.body.native) : null;
}

test.skipIf(process.env.OAR_TEST !== "codex-aimock").each([
  ["workspace-write", "workspaceWrite"], ["read-only", "readOnly"], ["danger-full-access", "dangerFullAccess"],
])("Codex roots apply on cold resume without changing %s", async (sandbox, type) => {
  const { root, cwd, first, second } = await directories();
  const provider = await startCodexAimock();
  let session: Session | undefined = undefined;
  try {
    const installation = await codexInstallation();
    if (installation.kind !== "available") { throw new Error("Codex unavailable"); }
    const options = { cwd, env: provider.env ?? {}, launchArgs: ["-c", `sandbox_mode="${sandbox}"`] };
    session = await codexSession(installation, { ...options, additionalDirectories: [first] });
    expect(codexOpen(session)).toMatchObject({ runtimeWorkspaceRoots: [cwd, first], sandbox: { type } });
    expect(await runTurn(session, "Say ok")).toEqual({ kind: "completed" });
    const id = session.id;
    await session.dispose();
    session = await codexSession(installation, { ...options, resume: id, additionalDirectories: ["../second extra"] });
    expect(codexOpen(session)).toMatchObject({ runtimeWorkspaceRoots: [cwd, second], sandbox: { type } });
    expect(session.model().value).toBe("gpt-5.1");
    expect(await runTurn(session, "Say ok again")).toEqual({ kind: "completed" });
  } finally { await session?.dispose(); await provider.stop(); await rm(root, { recursive: true, force: true }); }
}, 120_000);

test.skipIf(process.env.OAR_TEST !== "kimi-aimock")("Kimi supplies new-session directories in native context and refuses a resume override", async () => {
  const { root, cwd, first } = await directories();
  const provider = await startKimiAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); });
  let session: Session | undefined = undefined;
  try {
    const installation = await kimiInstallation();
    if (installation.kind !== "available") { throw new Error("Kimi unavailable"); }
    session = await kimiSession(installation, { cwd, env: provider.env, additionalDirectories: ["../first extra"] });
    expect(await runTurn(session, "Say ok")).toEqual({ kind: "completed" });
    expect(JSON.stringify(provider.raw.at(-1)?.body)).toContain(first);
    const id = session.id;
    await session.dispose();
    await expect(kimiSession(installation, { cwd, env: provider.env, resume: id, additionalDirectories: [first] }))
      .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "additionalDirectories" });
  } finally { await session?.dispose(); await provider.stop(); await rm(root, { recursive: true, force: true }); }
}, 120_000);
