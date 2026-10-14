import { describe, expect, test } from "vitest";
import { antigravityRuntime, type Session } from "../../packages/oar/src/index.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startAntigravityAimock, type AcpAimockEnv } from "../harness/aimock-acp.js";
import { runtimeUnderTest } from "../harness/subject.js";

/** The real 1.4.0 server and local harness, with provider bodies captured before aimock. */
async function turn(session: Session, env: AcpAimockEnv): Promise<readonly unknown[]> {
  const offset = env.raw.length;
  try {
    expect(await promptAndWait(session, "SETTINGS_OK", { timeoutMs: 60_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    return env.raw.slice(offset).map((request) => request.body);
  } finally {
    await session.dispose();
  }
}

function settings(bodies: readonly unknown[]): readonly { readonly system: string; readonly thinking: unknown }[] {
  return bodies.map((value) => {
    const body = asRecord(value);
    return {
      system: JSON.stringify(body?.systemInstruction),
      thinking: asRecord(asRecord(body?.generationConfig)?.thinkingConfig)?.thinkingLevel,
    };
  });
}

describe.skipIf(process.env.OAR_TEST !== "antigravity-aimock")("antigravity native settings", () => {
  test("append and effort reach the provider on creation and resume; omitting append removes it", async () => {
    const env = await startAntigravityAimock((mock) => { mock.onMessage(/SETTINGS_OK/u, { content: "SETTINGS_OK" }); });
    try {
      const subject = runtimeUnderTest(antigravityRuntime, env.env);
      const first = await subject.startSession({ model: "gemini-3.8-flash", effort: "low", appendSystemPrompt: "OAR_APPEND_FIRST_140" });
      expect(first.model().value).toBe("gemini-3.8-flash");
      expect(first.effort().value).toBe("low");
      const initial = settings(await turn(first, env));
      expect(initial).toHaveLength(1);
      expect(initial[0]?.system).toContain("OAR_APPEND_FIRST_140");
      expect(initial[0]?.thinking).toBe("low");
      // Appending retains the built-in harness instructions.
      expect(initial[0]?.system).toContain("Antigravity");

      const resumed = await subject.startSession({ resume: first.id, effort: "high", appendSystemPrompt: "OAR_APPEND_RESUMED_140" });
      expect(resumed.effort().value).toBe("high");
      const changed = settings(await turn(resumed, env));
      expect(changed).toHaveLength(1);
      expect(changed[0]?.system).toContain("OAR_APPEND_RESUMED_140");
      expect(changed[0]?.thinking).toBe("high");
      expect(changed[0]?.system).not.toContain("OAR_APPEND_FIRST_140");

      const omitted = await subject.startSession({ resume: first.id });
      const cleared = settings(await turn(omitted, env));
      expect(cleared).toHaveLength(1);
      expect(cleared[0]?.system).not.toMatch(/OAR_APPEND_(?:FIRST|RESUMED)_140/u);
      await expect(subject.startSession({ effort: "not-a-native-level" })).rejects.toThrow(/thinking_level=not-a-native-level was refused/u);
    } finally {
      await env.stop();
    }
  }, 180_000);
});
