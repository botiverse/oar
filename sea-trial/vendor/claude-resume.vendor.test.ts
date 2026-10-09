import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { claudeInstallation, claudeSession, type Session } from "../../packages/oar/src/index.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { runTurn } from "./support/asserts.js";

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("Claude missing resume fails during initialize without sending a model request", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-claude-missing-resume-"));
  const provider = await startClaudeAimock();
  const opened: { session?: Session } = {};
  try {
    const installation = await claudeInstallation();
    if (installation.kind !== "available") { throw new Error("Claude installation unavailable"); }
    const id = randomUUID();
    const failure: unknown = await claudeSession(installation, { cwd: directory, resume: id, env: { ...provider.env, CLAUDE_CONFIG_DIR: directory, ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null } })
      .then((session) => { opened.session = session; return session; }, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ message: `No conversation found with session ID: ${id}`, cause: { method: "initialize", native: { type: "result", subtype: "error_during_execution", is_error: true, errors: [`No conversation found with session ID: ${id}`], num_turns: 0 } } });
    expect(provider.mock.getRequests()).toEqual([]);
  } finally {
    await opened.session?.dispose();
    await provider.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("Claude existing resume completes initialize and remains usable for another turn", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-claude-existing-resume-"));
  const provider = await startClaudeAimock();
  let current: Session | undefined = undefined;
  try {
    const installation = await claudeInstallation();
    if (installation.kind !== "available") { throw new Error("Claude installation unavailable"); }
    const options = { cwd: directory, env: { ...provider.env, CLAUDE_CONFIG_DIR: directory, ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null } };
    current = await claudeSession(installation, options);
    await expect(runTurn(current, "first")).resolves.toEqual({ kind: "completed" });
    const id = current.id;
    await current.dispose();
    current = await claudeSession(installation, { ...options, resume: id });
    expect(current.id).toBe(id);
    expect(current.records().some((record) => record.kind === "frame" && record.body.type === "control_response")).toBe(false);
    await expect(runTurn(current, "second")).resolves.toEqual({ kind: "completed" });
  } finally {
    await current?.dispose();
    await provider.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
