import { expect, test } from "vitest";
import { claudeInstallation, claudeSession } from "../../packages/oar/src/index.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { expectAvailable, runTurn } from "./support/asserts.js";
import { lastAgentSystem, systemCapture } from "./support/system-prompt.js";

test.skipIf(process.env.OAR_TEST !== "claude-aimock").each(["include", "exclude"] as const)("long multiline prompts reach the provider with user configuration %s", async (userConfiguration) => {
  const capture = systemCapture();
  const env = await startClaudeAimock(capture.configure);
  const systemPrompt = `OAR_LONG_REPLACEMENT\n${"system line\n".repeat(4000)}OAR_REPLACEMENT_END`;
  const appendSystemPrompt = `OAR_LONG_APPEND\n${"append line\n".repeat(4000)}OAR_APPEND_END`;
  try {
    const installation = await claudeInstallation();
    expectAvailable(installation, "Claude");
    const session = await claudeSession(installation, { cwd: process.cwd(), env: env.env ?? {}, systemPrompt, appendSystemPrompt, userConfiguration });
    try {
      expect(await runTurn(session, "capture the prompt")).toEqual({ kind: "completed" });
      const actual = lastAgentSystem(capture.systems);
      expect(actual).toContain(systemPrompt);
      expect(actual).toContain(appendSystemPrompt);
    } finally { await session.dispose(); }
  } finally { await env.stop(); }
}, 60_000);
