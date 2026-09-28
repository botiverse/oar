import assert from "node:assert/strict";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import type { TrialCase } from "../harness/runner.js";
import type { RuntimeUnderTest } from "../harness/subject.js";

/*
 * SessionOptions.effort (contracts/session.ts): a requested effort is never
 * ignored. The runtime runs exactly that level (and `effort()` reads it back,
 * where the runtime reports one) or starting the session rejects, naming the
 * level. A runtime whose listModels lists effort levels accepts them, with
 * and without resume; one that lists none refuses an effort.
 */

type Attempt =
  | { readonly kind: "opened"; readonly session: Session }
  | { readonly kind: "refused"; readonly error: unknown };

async function attempt(subject: RuntimeUnderTest, overrides: Parameters<RuntimeUnderTest["startSession"]>[0]): Promise<Attempt> {
  const outcome = await subject.startSession(overrides).then(
    (session): Attempt => ({ kind: "opened", session }),
    (error: unknown): Attempt => ({ kind: "refused", error }),
  );
  return outcome;
}

/** The runtime's word on the level, where it gives one (claude's stream carries none), must be the requested level. */
function assertRunsEffort(session: Session, requested: string): void {
  const reported = session.effort().value;
  assert.ok(reported === null || reported === requested, `requested effort ${requested}, the runtime reports ${String(reported)}`);
}

async function completedTurn(session: Session, input: string): Promise<void> {
  const prompted = await session.prompt(input);
  assert.equal(prompted.kind, "accepted", `prompt ${JSON.stringify(input)} was not accepted: ${JSON.stringify(prompted.response.body)}`);
  assert.deepEqual(await awaitTurnEnd(session, prompted.seq), { kind: "completed" });
}

export const sessionEffortCases: readonly TrialCase[] = [
  {
    // Token-free on every backend: a level no runtime offers is either
    // refused at open, naming it, or (a runtime that forwards levels
    // unchecked, codex) read back exactly as given; never swapped for another.
    id: "session.effort-never-substituted",
    requires: ["installation", "session"],
    async run(subject) {
      const requested = "oar-no-such-effort";
      const opened = await attempt(subject, { effort: requested });
      if (opened.kind === "refused") {
        assert.match(String(opened.error), new RegExp(requested, "u"), "a refused effort names the requested level");
        return;
      }
      assert.equal(opened.session.effort().value, requested, "an effort the runtime took reads back exactly as requested");
      await opened.session.dispose();
    },
  },
  {
    // The invariant through listModels: a listed level is run, on a new
    // session and on a resume asking for another listed level; a model that
    // lists no levels refuses one.
    id: "session.effort-listed-levels-apply-across-resume",
    requires: ["installation", "session", "listModels"],
    async run(subject) {
      const installation = await subject.runtime.installation?.();
      const { listModels } = subject.runtime;
      assert.ok(installation?.kind === "available" && listModels !== undefined, "the runner checked both capabilities");
      const listed = await listModels(installation);
      assert.ok(listed.kind === "ok", `listModels answered ${listed.kind}`);
      const wanted = process.env.OAR_TEST_MODEL;
      const candidates = listed.models.filter((model) => model.disabled === undefined && (wanted === undefined || model.id === wanted));
      const entry = candidates.find((model) => (model.effortLevels?.length ?? 0) >= 2);
      const [first, second] = entry?.effortLevels ?? [];
      if (entry === undefined || first === undefined || second === undefined) {
        const model = candidates.at(0)?.id;
        const refused = await attempt(subject, { ...(model === undefined ? {} : { model }), effort: "low" });
        assert.equal(refused.kind, "refused", `${model ?? "the default model"} lists no effort levels, yet an effort was taken`);
        return;
      }
      const session = await subject.startSession({ model: entry.id, effort: first });
      assertRunsEffort(session, first);
      await completedTurn(session, "hello");
      const sessionId = session.id;
      await session.dispose();

      const resumed = await subject.startSession({ resume: sessionId, model: entry.id, effort: second });
      assert.equal(resumed.id, sessionId, "a resumed session keeps the runtime-native id");
      assertRunsEffort(resumed, second);
      await completedTurn(resumed, "hello again");
      await resumed.dispose();
    },
  },
];
