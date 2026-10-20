import type { claudeOpenSettings } from "../../packages/oar/src/runtimes/claude/open-settings.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { claudeInstallation, claudeSession, type Session } from "../../packages/oar/src/index.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { runTurn } from "./support/asserts.js";
import { hookMarks, processRunning, sessionStartHook } from "./support/session-start-hook.js";

// Real hooks, short internal limits; no public option or environment override.
vi.mock("../../packages/oar/src/runtimes/claude/open-settings.js", async (original) => {
  const actual = await original<{ claudeOpenSettings: typeof claudeOpenSettings }>();
  return { ...actual, claudeOpenSettings: (child: Parameters<typeof actual.claudeOpenSettings>[0]) => actual.claudeOpenSettings(child, { readbackMs: 4000, hookMs: 8000 }) };
});

function assertHookFrames(session: Session): void {
  const hooks = session.records().filter((record) => record.kind === "frame" && record.body.type.startsWith("system/hook_"));
  expect(hooks.map((record) => record.kind === "frame" ? record.body.type : "")).toEqual(["system/hook_started", "system/hook_response"]);
  expect(session.records().some((record) => record.kind === "frame" && record.body.type === "control_response")).toBe(false);
}

async function fixture(delayMs: number) {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-claude-open-hook-"));
  const provider = await startClaudeAimock();
  const hook = sessionStartHook(directory, delayMs);
  await writeFile(path.join(directory, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hook.command, timeout: 60 }] }] } }));
  const installation = await claudeInstallation();
  assert.equal(installation.kind, "available");
  return {
    installation, hook, provider,
    options: { cwd: directory, model: "sonnet", env: { ...provider.env, CLAUDE_CONFIG_DIR: directory, ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null } },
    async close() {
      await provider.stop();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    },
  };
}

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("Claude real SessionStart hooks outlast the readback budget for effort, resume and serviceTier", async () => {
  const env = await fixture(5000);
  let current: Session | undefined = undefined;
  try {
    current = await claudeSession(env.installation, { ...env.options, effort: "low" });
    assertHookFrames(current);
    expect(env.provider.mock.getRequests()).toEqual([]);
    await runTurn(current, "persist this session");
    const id = current.id;
    await current.dispose();
    current = await claudeSession(env.installation, { ...env.options, resume: id, effort: "low", serviceTier: "default" });
    assertHookFrames(current);
    await current.dispose();
    current = await claudeSession(env.installation, { ...env.options, serviceTier: "default" });
    assertHookFrames(current);
    const marks = await hookMarks(env.hook.file);
    expect(marks.map(({ phase, source }) => ({ phase, source }))).toEqual([
      { phase: "start", source: "startup" }, { phase: "end", source: "startup" },
      { phase: "start", source: "resume" }, { phase: "end", source: "resume" },
      { phase: "start", source: "startup" }, { phase: "end", source: "startup" },
    ]);
  } finally { await current?.dispose(); await env.close(); }
}, 120_000);

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("Claude caps a real SessionStart hook, names it and kills its process tree", async () => {
  const env = await fixture(20_000);
  const opened: { session?: Session } = {};
  try {
    const failure: unknown = await claudeSession(env.installation, { ...env.options, effort: "low" }).then((session) => { opened.session = session; return session; }, (error: unknown) => error);
    expect(failure).toMatchObject({ message: "claude SessionStart hooks exceeded the 8000 ms opening pause budget while waiting for get_settings; still running: SessionStart:startup, so effort low cannot be confirmed" });
    const marks = await hookMarks(env.hook.file);
    expect(marks.map(({ phase }) => phase)).toEqual(["start"]);
    const pid = marks[0]?.pid;
    assert.ok(typeof pid === "number");
    await vi.waitFor(() => { expect(processRunning(pid)).toBe(false); }, { timeout: 10_000 });
    expect(env.provider.mock.getRequests()).toEqual([]);
  } finally { await opened.session?.dispose(); await env.close(); }
}, 120_000);
