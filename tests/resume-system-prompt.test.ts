import { afterEach, expect, test, vi } from "vitest";
import { UnsupportedOptionError } from "../packages/oar/src/contracts/errors.js";
import { claudeSession } from "../packages/oar/src/runtimes/claude/session.js";
import { codexSession } from "../packages/oar/src/runtimes/codex/session.js";

const spawnLineProcess = vi.hoisted(() => vi.fn(() => { throw new Error("must not start a process"); }));
vi.mock("../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockClear(); });

test.each(([
  { runtime: "claude", session: claudeSession, option: "systemPrompt" },
  { runtime: "claude", session: claudeSession, option: "appendSystemPrompt" },
  { runtime: "codex", session: codexSession, option: "appendSystemPrompt" },
] as const).flatMap((entry) => ["", "same prompt the host sends on every open"].map((value) => ({ runtime: entry.runtime, session: entry.session, option: entry.option, value }))))("$runtime rejects resumed $option=$value before starting any process", async ({ runtime, session, option, value }) => {
  // An explicitly empty value is still an instruction, not an omission. A
  // repeated value also cannot be compared without an authoritative readback.
  const failure: unknown = await session({ kind: "available", via: "executable", command: runtime }, {
      cwd: process.cwd(), resume: "saved-session", [option]: value,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(UnsupportedOptionError);
  expect(failure).toHaveProperty("option", option);
  expect(spawnLineProcess).not.toHaveBeenCalled();
  expect(failure).toHaveProperty("message", expect.stringContaining("Omit"));
  expect(failure).toHaveProperty("message", expect.stringContaining("new session"));
});
