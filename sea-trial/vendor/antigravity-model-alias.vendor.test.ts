import { describe, expect, test } from "vitest";
import { antigravityRuntime, ModelConfirmationError, UnsupportedOptionError } from "../../packages/oar/src/index.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { startAntigravityAimock } from "../harness/aimock-acp.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { retainTurnFailure } from "../harness/turn-failure.js";

describe.skipIf(process.env.OAR_TEST !== "antigravity-aimock")("Antigravity native composite model selectors", () => {
  test("saved composite selectors reach the provider on creation and resume", async () => {
    const env = await startAntigravityAimock(mock => { mock.onMessage(/ALIAS_OK/u, { content: "ALIAS_OK" }); });
    try {
      const subject = runtimeUnderTest(antigravityRuntime, env.env);
      let resume: string | undefined = undefined;
      for (const level of ["low", "high"]) {
        const phase = resume === undefined ? "creation" : "resume";
        const session = await subject.startSession({ model: `gemini-3.8-flash-${level}`, ...(resume === undefined ? {} : { resume }) });
        resume = session.id;
        try {
          expect(session.model().value).toBe("gemini-3.8-flash");
          expect(session.effort().value).toBe(level);
          const offset = env.raw.length;
          const outcome = await promptAndWait(session, "ALIAS_OK", { timeoutMs: 60_000 });
          if (outcome.kind !== "ended" || outcome.outcome.kind !== "completed") {
            await retainTurnFailure(session, outcome, { test: "antigravity-model-alias", phase, level });
          }
          expect(outcome).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
          expect(env.raw.slice(offset).some(request => JSON.stringify(request.body).includes(`"thinkingLevel":"${level.toUpperCase()}"`))).toBe(true);
        } finally { await session.dispose(); }
      }
      const count = env.raw.length;
      await expect(subject.startSession({ model: "gemini-3.8-flash-high", effort: "low" })).rejects.toBeInstanceOf(UnsupportedOptionError);
      await expect(subject.startSession({ model: "gemini-3.8-flash-unknown" })).rejects.toBeInstanceOf(ModelConfirmationError);
      expect(env.raw).toHaveLength(count);
    } finally { await env.stop(); }
  }, 180_000);
});
