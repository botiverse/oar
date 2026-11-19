import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { Session, SessionOptions, StartSession } from "../../packages/oar/src/contracts/session.js";
import type { AcpSessionProfile } from "../../packages/oar/src/shared/acp/profile.js";
import { opencodeSession } from "../../packages/oar/src/runtimes/opencode/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { scriptedRuntime } from "../../packages/oar/src/testing/index.js";

// The v2 prompt path: overlay, read-back and file cleanup around a stand-in ACP open.
const { opening, profiles } = vi.hoisted(() => { const opened: AcpSessionProfile[] = []; return { opening: vi.fn<StartSession>(), profiles: opened }; });
vi.mock("../../packages/oar/src/shared/acp/session.js", () => ({ acpSession: (profile: AcpSessionProfile) => { profiles.push(profile); return opening; } }));
vi.mock("../../packages/oar/src/shared/executable/run.js", () => ({
  // oxlint-disable-next-line typescript/promise-function-async -- a resolved `debug agents --standalone` stand-in.
  runExecutable: () => Promise.resolve({ ok: true, stdout: JSON.stringify([{ id: "build", mode: "primary" }, { id: "explore", mode: "subagent" }]), stderr: "", exitCode: 0 }),
}));
const installation = { kind: "available", via: "executable", command: "not-spawned", version: "opencode v2.3.2" } as const;
const sessions: Session[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async (session) => session.dispose()));
  opening.mockReset();
  profiles.splice(0);
});

function overlay(options: SessionOptions): Record<string, unknown> {
  const parsed = asRecord(JSON.parse(options.env?.OPENCODE_CONFIG_CONTENT ?? "{}"));
  assert.ok(parsed !== null);
  return parsed;
}

function instructionsFile(options: SessionOptions): string {
  const files = overlay(options).instructions;
  assert.ok(Array.isArray(files) && typeof files[0] === "string");
  return files[0];
}

async function native(): Promise<Session> {
  const session = await scriptedRuntime({ id: "v2-prompts", turn: () => {} }).session({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  sessions.push(session);
  return session;
}

async function readBack(mode: string): Promise<void> {
  const configure = profiles.at(-1)?.configureSession;
  assert.ok(configure !== undefined);
  const response = { configOptions: [{ category: "mode", currentValue: mode }] };
  // oxlint-disable-next-line typescript/promise-function-async -- the read-back never calls back into ACP.
  await configure({ response, sessionId: "native", options: { cwd: process.cwd() }, request: () => Promise.reject(new Error("no ACP call expected")) });
}

test("both prompts reach the ACP open with the listed primary agent only", async () => {
  opening.mockResolvedValue(await native());
  const session = await opencodeSession(installation, { cwd: process.cwd(), systemPrompt: "replacement", appendSystemPrompt: "extra" });
  sessions.push(session);
  const options = opening.mock.calls[0]?.[1];
  assert.ok(options !== undefined);
  expect(overlay(options)).toEqual({ agents: { build: { system: "replacement" } }, instructions: [instructionsFile(options)] });
});

test("the read-back accepts a configured agent and refuses another", async () => {
  opening.mockResolvedValue(await native());
  sessions.push(await opencodeSession(installation, { cwd: process.cwd(), systemPrompt: "replacement" }));
  await expect(readBack("build")).resolves.toBeUndefined();
  await expect(readBack("plan")).rejects.toThrow('opened on agent "plan", but the system prompt was configured for "build"');
});

test("disposal removes the instructions file", async () => {
  opening.mockResolvedValue(await native());
  const session = await opencodeSession(installation, { cwd: process.cwd(), appendSystemPrompt: "extra" });
  const options = opening.mock.calls[0]?.[1];
  assert.ok(options !== undefined);
  const file = instructionsFile(options);
  await access(file);
  await session.dispose();
  await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a failed ACP open removes the instructions file it received", async () => {
  let file = "";
  opening.mockImplementation(async (_installation, options) => {
    file = instructionsFile(options);
    await access(file);
    throw new Error("native open failed");
  });
  await expect(opencodeSession(installation, { cwd: process.cwd(), appendSystemPrompt: "extra" })).rejects.toThrow("native open failed");
  await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
});

test("without prompt options the v2 open takes the session options unchanged", async () => {
  opening.mockResolvedValue(await native());
  const options = { cwd: process.cwd(), env: { OPENCODE_CONFIG_CONTENT: "existing" } };
  sessions.push(await opencodeSession(installation, options));
  expect(opening.mock.calls[0]?.[1]).toBe(options);
});
