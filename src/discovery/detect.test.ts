import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeDriver } from "../backend/trait.js";
import {
  detectAllRegistered,
  ModelsProbeError,
  type DetectFailure,
} from "./detect.js";
import type { ModelInfo } from "../config/model.js";
import { emptyDeclaration } from "../backend/trait.js";
import type { RuntimeEvent } from "../events/event.js";

function stub(
  id: string,
  detect: () => Promise<{ version: string } | null>,
  models: () => Promise<readonly ModelInfo[]>,
): RuntimeDriver {
  return {
    id,
    detect,
    models,
    describe: emptyDeclaration,
    normalise: (_raw: unknown): readonly RuntimeEvent[] => [],
    // detect-only stub: these tests never call start().
    start: async () => {
      throw new Error("stub driver: start() not implemented");
    },
  };
}

test("empty models after detect is models_unavailable, not healthy", async () => {
  const descs = await detectAllRegistered(
    [stub("agy-empty", async () => ({ version: "1.1.11" }), async () => [])],
    ["agy-empty"],
  );
  assert.equal(descs[0]!.failure, "models_unavailable");
  assert.equal(descs[0]!.models.length, 0);
});

test("ModelsProbeError needs_login is preserved (not collapsed to None)", async () => {
  const descs = await detectAllRegistered(
    [
      stub("agy-login", async () => ({ version: "1.1.11" }), async () => {
        throw new ModelsProbeError(
          "needs_login",
          "Please sign in to view available models.",
        );
      }),
    ],
    ["agy-login"],
  );
  assert.equal(descs[0]!.failure, "needs_login" satisfies DetectFailure);
  assert.equal(descs[0]!.models.length, 0);
});

test("detect throw is detect_failed, not not_installed", async () => {
  const descs = await detectAllRegistered(
    [
      stub("broken", async () => {
        throw new Error("boom");
      }, async () => []),
    ],
    ["broken"],
  );
  assert.equal(descs[0]!.failure, "detect_failed");
});

test("detect null becomes not_installed via registry fill", async () => {
  const descs = await detectAllRegistered(
    [stub("missing", async () => null, async () => [])],
    ["missing"],
  );
  assert.equal(descs[0]!.failure, "not_installed");
});

test("ready: models non-empty, failure undefined", async () => {
  const descs = await detectAllRegistered(
    [
      stub(
        "ok",
        async () => ({ version: "1" }),
        async () => [{ id: "m1", label: "m1", options: [] }],
      ),
    ],
    ["ok"],
  );
  assert.equal(descs[0]!.failure, undefined);
  assert.equal(descs[0]!.models.length, 1);
});


function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("timings present and delay does not change failure state", async () => {
  const descs = await detectAllRegistered(
    [
      stub(
        "slow-ok",
        async () => {
          await delay(30);
          return { version: "1" };
        },
        async () => {
          await delay(40);
          return [{ id: "m1", label: "m1", options: [] }];
        },
      ),
    ],
    ["slow-ok"],
  );
  const d0 = descs[0];
  assert.ok(d0);
  assert.equal(d0.failure, undefined);
  assert.ok(d0.timings);
  const tm = d0.timings;
  assert.ok(tm.detectMs >= 20);
  assert.ok((tm.modelsMs ?? 0) >= 20);
  assert.ok(tm.totalMs >= tm.detectMs);
});

test("models budget timeout yields models_unavailable with timings", async () => {
  const descs = await detectAllRegistered(
    [
      stub(
        "hang-models",
        async () => ({ version: "1" }),
        async () => {
          await delay(200);
          return [{ id: "m1", label: "m1", options: [] }];
        },
      ),
    ],
    ["hang-models"],
    { modelsBudgetMs: 30 },
  );
  const d0 = descs[0];
  assert.ok(d0);
  assert.equal(d0.failure, "models_unavailable");
  assert.ok(d0.timings);
  assert.ok((d0.timings.modelsMs ?? 0) >= 25);
  assert.equal(d0.models.length, 0);
});
