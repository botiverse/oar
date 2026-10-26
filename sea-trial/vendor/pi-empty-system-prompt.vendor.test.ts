import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { UnsupportedOptionError, type Session, type SessionOptions } from "../../packages/oar/src/index.js";
import { startPiAimock } from "../harness/aimock.js";
import { isPiBackend, piTestRuntime } from "./support/pi-runtime.js";
import { runTurn } from "./support/asserts.js";
import { lastAgentSystem, systemCapture } from "./support/system-prompt.js";

const DEFAULT_PROMPT = "You are an expert coding assistant operating inside pi";

async function fixture() {
  const capture = systemCapture();
  const env = await startPiAimock(capture.configure);
  const agentDir = process.env.OAR_PI_AGENT_DIR;
  assert.ok(agentDir !== undefined);
  const cwd = path.join(agentDir, "empty-prompt-project");
  await mkdir(cwd);
  const installation = await piTestRuntime.installation();
  assert.ok(installation.kind === "available");
  return { env, capture,
    open: async (options: Partial<SessionOptions>) => {
      const session = await piTestRuntime.session(installation, { cwd, model: "aimock/aimock-model", ...options, env: { ...env.env, ...options.env } });
      return session;
    },
  };
}

describe.skipIf(!isPiBackend)("Pi empty replacement prompt", () => {
  test("rejects an empty replacement instead of silently sending the native default", async () => {
    const f = await fixture();
    let session: Session | undefined = undefined;
    let failure: unknown = undefined;
    try {
      try { session = await f.open({ systemPrompt: "" }); }
      catch (error) { failure = error; }
      // If the guard regresses, exercise the real provider request so the
      // failure retains evidence of Pi's default-prompt fallback.
      if (session !== undefined) { await runTurn(session, "capture empty replacement"); }
      expect({ rejected: failure instanceof UnsupportedOptionError, defaultPromptSent: f.capture.systems.some((system) => system.includes(DEFAULT_PROMPT)) })
        .toEqual({ rejected: true, defaultPromptSent: false });
      assert.ok(failure instanceof UnsupportedOptionError);
      expect(failure.option).toBe("systemPrompt");
      expect(failure.message).toContain("empty");
      expect(f.capture.systems).toEqual([]);
    } finally {
      await session?.dispose();
      await f.env.stop();
    }
  }, 60_000);

  test("a whitespace-only replacement still removes the native base prompt", async () => {
    const f = await fixture();
    let session: Session | undefined = undefined;
    try {
      session = await f.open({ systemPrompt: " \t\n ", appendSystemPrompt: "" });
      expect(await runTurn(session, "capture whitespace replacement")).toEqual({ kind: "completed" });
      expect(lastAgentSystem(f.capture.systems)).not.toContain(DEFAULT_PROMPT);
    } finally { await session?.dispose(); await f.env.stop(); }
  }, 60_000);

  test("an empty append keeps the default base prompt", async () => {
    const f = await fixture();
    let session: Session | undefined = undefined;
    try {
      session = await f.open({ appendSystemPrompt: "" });
      expect(await runTurn(session, "capture empty append")).toEqual({ kind: "completed" });
      expect(lastAgentSystem(f.capture.systems)).toContain(DEFAULT_PROMPT);
    } finally { await session?.dispose(); await f.env.stop(); }
  }, 60_000);
});
