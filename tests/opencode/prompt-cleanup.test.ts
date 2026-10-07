import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { Session, SessionOptions, StartSession } from "../../packages/oar/src/contracts/session.js";
import { opencodeSession } from "../../packages/oar/src/runtimes/opencode/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { scriptedRuntime } from "../../packages/oar/src/testing/index.js";

const { opening } = vi.hoisted(() => ({ opening: vi.fn<StartSession>() }));
vi.mock("../../packages/oar/src/shared/acp/session.js", () => ({ acpSession: () => opening }));
const installation = { kind: "available", via: "executable", command: "not-spawned" } as const;
const sessions: Session[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async (session) => session.dispose()));
  opening.mockReset();
});

function temporaryFile(options: SessionOptions): string {
  const overlay = asRecord(JSON.parse(options.env?.OPENCODE_CONFIG_CONTENT ?? "{}"));
  const files = overlay?.instructions;
  assert.ok(Array.isArray(files));
  const file: unknown = files[0];
  assert.ok(typeof file === "string");
  return file;
}

function openOptions(): SessionOptions {
  const [call] = opening.mock.calls;
  assert.ok(call !== undefined);
  return call[1];
}

async function setup(): Promise<Session> {
  const runtime = scriptedRuntime({ id: "cleanup", turn: () => {} });
  const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  sessions.push(session);
  opening.mockResolvedValue(session);
  return session;
}

test("baseline opens directly without injecting configuration", async () => {
  await setup();
  const options = { cwd: process.cwd(), env: { OPENCODE_CONFIG_CONTENT: "existing" } };
  await opencodeSession(installation, options);
  expect(opening.mock.calls[0]?.[1]).toBe(options);
});

test("concurrent disposals wait for the child before removing its instructions", async () => {
  const native = await setup();
  const dispose = native.dispose.bind(native);
  let file = "";
  vi.spyOn(native, "dispose").mockImplementationOnce(async () => { await access(file); await dispose(); });
  const session = await opencodeSession(installation, { cwd: process.cwd(), appendSystemPrompt: "extra" });
  sessions.push(session);
  file = temporaryFile(openOptions());
  await Promise.all([session.dispose(), session.dispose()]);
  await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an exit before host disposal removes instructions", async () => {
  const native = await setup();
  const session = await opencodeSession(installation, { cwd: process.cwd(), appendSystemPrompt: "extra" });
  sessions.push(session);
  const file = temporaryFile(openOptions());
  await native.dispose();
  await expect.poll(async () => {
    try { await access(file); return false; } catch { return true; }
  }).toBe(true);
});

test("failed ACP open cleans up the file it received", async () => {
  let file = "";
  opening.mockImplementation(async (_installation, options) => {
    file = temporaryFile(options);
    await access(file);
    throw new Error("native open failed");
  });
  await expect(opencodeSession(installation, { cwd: process.cwd(), appendSystemPrompt: "extra" })).rejects.toThrow("native open failed");
  await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([
  { systemPrompt: "replacement" },
  { appendSystemPrompt: "extra" },
])("MCP refusal precedes prompt preparation and ACP opening: %j", async (prompt) => {
  await expect(opencodeSession(installation, {
    cwd: process.cwd(),
    ...prompt,
    mcpServers: [{ name: "probe", command: "not-spawned" }],
  })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "mcpServers" });
  expect(opening).not.toHaveBeenCalled();
});
