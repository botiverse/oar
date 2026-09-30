import assert from "node:assert/strict";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import type { TrialCase } from "../harness/runner.js";
import type { RuntimeUnderTest } from "../harness/subject.js";

/*
 * SessionOptions on a resume (contracts/session.ts, oar#22): a model asked for
 * on a resume is run, or the resume is refused naming it. Never the model the
 * session ran before, kept without a word. The provider-side view of the same
 * contract, for model and prompts, is sea-trial/vendor/resume-overrides.vendor.test.ts.
 */

async function completedTurn(session: Session, input: string): Promise<void> {
  const prompted = await session.prompt(input);
  assert.equal(prompted.kind, "accepted", `prompt ${JSON.stringify(input)} was not accepted: ${JSON.stringify(prompted.response.body)}`);
  assert.deepEqual(await awaitTurnEnd(session, prompted.seq), { kind: "completed" });
}

export const sessionResumeOverridesCases: readonly TrialCase[] = [
  {
    id: "session.model-on-resume-applies-or-refused",
    requires: ["installation", "session", "listModels"],
    async run(subject: RuntimeUnderTest) {
      const installation = await subject.runtime.installation?.();
      const { listModels } = subject.runtime;
      assert.ok(installation?.kind === "available" && listModels !== undefined, "the runner checked both capabilities");
      const listed = await listModels(installation);
      assert.ok(listed.kind === "ok", `listModels answered ${listed.kind}`);
      const usable = listed.models.filter((model) => model.disabled === undefined);
      const first = usable.find((model) => model.id === process.env.OAR_TEST_MODEL) ?? usable.at(0);
      const second = usable.find((model) => (model.resolvedId ?? model.id) !== (first?.resolvedId ?? first?.id));
      if (first === undefined || second === undefined) {
        return; // one model listed: nothing to switch to
      }
      const session = await subject.startSession({ model: first.id });
      await completedTurn(session, "hello");
      const sessionId = session.id;
      await session.dispose();

      const resumed = await subject.startSession({ resume: sessionId, model: second.id }).then(
        (opened) => ({ kind: "opened", session: opened }) as const,
        (error: unknown) => ({ kind: "refused", error }) as const,
      );
      if (resumed.kind === "refused") {
        assert.ok(String(resumed.error).includes(second.id), `a refused model names the requested model ${second.id}: ${String(resumed.error)}`);
        return;
      }
      const opened = resumed.session;
      assert.equal(opened.id, sessionId, "a resumed session keeps the runtime-native id");
      await completedTurn(opened, "hello again");
      const reported = opened.model().value;
      assert.ok(
        reported === null || reported === second.id || reported === second.resolvedId,
        `resumed with model ${second.id}, the runtime reports ${String(reported)}`,
      );
      await opened.dispose();
    },
  },
];
