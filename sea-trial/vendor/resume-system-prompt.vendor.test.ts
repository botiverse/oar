import { describe, expect, test } from "vitest";
import { claudeInstallation, claudeSession, codexInstallation, codexSession, defineRuntime, UnsupportedOptionError } from "../../packages/oar/src/index.js";
import { startClaudeAimock, startCodexAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { runTurn } from "./support/asserts.js";
import { lastAgentSystem, systemCapture } from "./support/system-prompt.js";

for (const backend of ["claude", "codex"] as const) {
  describe.skipIf(process.env.OAR_TEST !== `${backend}-aimock`)(`${backend} resumed system prompts`, () => {
    // oxlint-disable-next-line eslint/max-statements -- Creation, refusal and omission are one native continuation scenario.
    test.each(["systemPrompt", "appendSystemPrompt"] as const)("resumed %s applies or is refused, with omission preserving saved instructions", async (option) => {
      const capture = systemCapture();
      const env = await (backend === "claude" ? startClaudeAimock : startCodexAimock)(capture.configure);
      const runtime = backend === "claude"
        ? defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation })
        : defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation });
      const subject = runtimeUnderTest(runtime, env.env);
      try {
        const first = await subject.startSession({ [option]: "OAR_OLD_SYSTEM_INSTRUCTION_7319" });
        try { await runTurn(first, "first request"); }
        finally { await first.dispose(); }
        expect(lastAgentSystem(capture.systems)).toContain("OAR_OLD_SYSTEM_INSTRUCTION_7319");
        const replacementSupported = backend === "codex" && option === "systemPrompt";
        if (!replacementSupported) {
          const before = capture.systems.length;
          await expect(subject.startSession({ resume: first.id, [option]: "OAR_NEW_SYSTEM_INSTRUCTION_8420" })).rejects.toBeInstanceOf(UnsupportedOptionError);
          expect(capture.systems).toHaveLength(before);
        }
        const resumed = await subject.startSession({ resume: first.id, ...(replacementSupported ? { systemPrompt: "OAR_NEW_SYSTEM_INSTRUCTION_8420" } : {}) });
        try { await runTurn(resumed, "request after resume"); }
        finally { await resumed.dispose(); }
        const system = lastAgentSystem(capture.systems);
        expect(system).toContain(replacementSupported ? "OAR_NEW_SYSTEM_INSTRUCTION_8420" : "OAR_OLD_SYSTEM_INSTRUCTION_7319");
        expect(system).not.toContain(replacementSupported ? "OAR_OLD_SYSTEM_INSTRUCTION_7319" : "OAR_NEW_SYSTEM_INSTRUCTION_8420");
      } finally { await env.stop(); }
    }, 120_000);
  });
}
