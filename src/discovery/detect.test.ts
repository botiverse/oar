import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeDriver } from "../backend/trait.js";
import {
  detectAllRegistered,
  ModelsProbeError,
  type DetectFailure,
} from "./detect.js";
import type { ModelInfo } from "../config/model.js";
import type { Declaration } from "../backend/trait.js";
import type { LaunchSpec } from "../backend/process/lifecycle.js";
import type { RuntimeEvent } from "../events/event.js";

const emptyDecl = async (): Promise<Declaration> => ({
  capabilities: { steer: false, interrupt: false, resume: false, interceptToolCalls: false },
  config: { options: [], unsupported: [] },
});

function stub(
  id: string,
  detect: () => Promise<{ version: string } | null>,
  models: () => Promise<readonly ModelInfo[]>,
): RuntimeDriver {
  return {
    id,
    detect,
    models,
    describe: emptyDecl,
    plan: (): LaunchSpec => ({ command: id, args: [], env: {} }),
    readiness: { kind: "process_spawned" },
    shutdown: { graceMs: 1000, onGraceExpiry: "immediate" },
    normalise: (_raw: unknown): readonly RuntimeEvent[] => [],
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
