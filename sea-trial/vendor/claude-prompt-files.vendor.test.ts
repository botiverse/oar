import { expect, test } from "vitest";
import { claudeInstallation, claudeSession, defineRuntime } from "../../packages/oar/src/index.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { runTurn } from "./support/asserts.js";
import { lastAgentSystem, systemCapture } from "./support/system-prompt.js";

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("long multiline system prompts reach the provider through private files", async () => {
  const capture = systemCapture();
  const env = await startClaudeAimock(capture.configure);
  const systemPrompt = `OAR_LONG_REPLACEMENT\n${"system line\n".repeat(4000)}OAR_REPLACEMENT_END`;
  const appendSystemPrompt = `OAR_LONG_APPEND\n${"append line\n".repeat(4000)}OAR_APPEND_END`;
  try {
    const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });
    const session = await runtimeUnderTest(runtime, env.env).startSession({ systemPrompt, appendSystemPrompt });
    try {
      expect(await runTurn(session, "capture the prompt")).toEqual({ kind: "completed" });
      const actual = lastAgentSystem(capture.systems);
      expect(actual).toContain(systemPrompt);
      expect(actual).toContain(appendSystemPrompt);
    } finally { await session.dispose(); }
  } finally { await env.stop(); }
}, 60_000);
