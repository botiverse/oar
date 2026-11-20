import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { fakeLoginCli } from "../fixtures/login-fixtures.js";

const dir = mkdtempSync(path.join(tmpdir(), "oar-claude-early-exit-"));
const cli = fakeLoginCli({ dir, name: "claude", script: "startup-stderr.mts", state: {} });
const installation = { kind: "available", via: "executable", command: cli.command, version: "2.1.328" } as const;
const env = { FIXTURE_TOKEN: "dummy-diagnostic-token", CLAUDE_CONFIG_DIR: dir };
const reason = "stderr (tail):\nstartup refused: [redacted] [redacted]";

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

test("a native exit before the first frame carries bounded redacted stderr in the returned session", async () => {
  const session = await claudeSession(installation, { cwd: dir, env });
  try {
    await vi.waitFor(() => { expect(session.records()).toContainEqual(expect.objectContaining({
      kind: "response", body: { kind: "exited", code: 1, reason },
    })); }, { timeout: 15_000 });
    expect(JSON.stringify(session.records())).not.toMatch(/opaque-leading-fragment|dummy-diagnostic-token|sk-diagnostic/u);
  } finally { await session.dispose(); }
});

test("an exit during the open handshake carries the same safe tail in the rejection", async () => {
  const failure: unknown = await claudeSession(installation, { cwd: dir, env, effort: "low" }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty("message", expect.stringContaining(reason));
  expect(failure).toHaveProperty("stack", expect.not.stringMatching(/opaque-leading-fragment|dummy-diagnostic-token|sk-diagnostic/u));
});

test("an unexpected exit after the first protocol frame retains the same bounded redacted stderr", async () => {
  const session = await claudeSession(installation, { cwd: dir, env: { ...env, OAR_DIAGNOSTIC_FRAME: "first" } });
  try {
    await vi.waitFor(() => { expect(session.records()).toContainEqual(expect.objectContaining({
      kind: "response", body: { kind: "exited", code: 1, reason },
    })); }, { timeout: 15_000 });
  } finally { await session.dispose(); }
});
