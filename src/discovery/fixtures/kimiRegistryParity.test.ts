import assert from "node:assert/strict";
import test from "node:test";
import {
  RAFT_DEPRECATED_FOR_CREATE,
  RAFT_DRIVER_REGISTRY,
  assertFixtureCoversRegistry,
  creatableDescriptors,
  deprecatedExcluded,
  fixtureDescriptors,
} from "./raftRuntimes.js";

/**
 * Registry/form boundary for the two Kimi identities (task #5, Huaihuai
 * 2026-08-13). Two separate obligations that pull in opposite directions, so
 * each needs its own tooth:
 *
 *   ENUMERATED  `kimi-cli` must appear in registered detect, or the Raft
 *               adapter never receives the legacy row at all.
 *   NOT OFFERED `kimi-cli` maps onto Raft's legacy `kimi`, which exists only
 *               for already-created agents. Offering it on the create form
 *               would resurrect it for new ones.
 *
 * The failure this guards is silent in both directions: dropping the id makes
 * the adapter blind, and forgetting the deprecation makes a retired runtime
 * quietly creatable again. Neither shows up in the detect matrix tests, which
 * are handed their registry ids explicitly.
 */

test("kimi-cli is enumerated in the detect registry", () => {
  assert.ok(
    RAFT_DRIVER_REGISTRY.includes("kimi-cli"),
    "adapter cannot see the legacy row unless kimi-cli is registered",
  );
  assert.ok(RAFT_DRIVER_REGISTRY.includes("kimi"), "canonical kimi must stay registered");
});

test("kimi-cli is excluded from the create form; canonical kimi is not", () => {
  const creatable = new Set(creatableDescriptors().map((d) => d.runtime));
  assert.ok(!creatable.has("kimi-cli"), "legacy kimi-cli must not be offered for new agents");
  assert.ok(creatable.has("kimi"), "canonical kimi must remain creatable");

  // Also assert via the exclusion list itself, so a change that drops kimi-cli
  // from the fixtures entirely (making the filter vacuously "correct") cannot
  // pass this test.
  const excluded = new Set(deprecatedExcluded().map((d) => d.runtime));
  assert.ok(excluded.has("kimi-cli"));
  assert.ok(RAFT_DEPRECATED_FOR_CREATE.includes("kimi-cli"));
});

test("both Kimi identities have fixture coverage", () => {
  // assertFixtureCoversRegistry enforces "every registry id has a fixture" AND
  // equal sizes, so it catches an id added to one side only — in either
  // direction. Called here (not only from the teeth script) so the ordinary
  // test run fails too.
  assertFixtureCoversRegistry();
  const ids = new Set(fixtureDescriptors().map((d) => d.runtime));
  assert.ok(ids.has("kimi"));
  assert.ok(ids.has("kimi-cli"));
});
