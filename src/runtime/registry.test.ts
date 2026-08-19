import assert from "node:assert/strict";
import test from "node:test";
import {
  createHostDrivers,
  createHostInstallTargets,
  createHostRuntimeDefinitions,
} from "./registry.js";
import { RAFT_DRIVER_REGISTRY } from "../discovery/fixtures/raftRuntimes.js";
import { createDriverFromDefinition } from "./projections.js";

/**
 * Live assembly identity: one RuntimeDefinition is the source from which the
 * catalog/session and install views are projected.
 *
 * A previous two-registry design needed an order-sensitive parity assertion.
 * That was the wrong shape: it detected drift after two identity lists had
 * already diverged. The canonical definition list makes that divergence
 * unrepresentable; these tests now protect the remaining external registry and
 * definition/driver identity seams.
 *
 * Missing a definition still has a silent consequence in
 * `detectAllRegistered()`: the external registry row becomes a confident
 * `not_installed`. Therefore external-registry parity remains a real tooth.
 */

test("no driver id is registered twice in the live assembly", () => {
  const ids = createHostRuntimeDefinitions().map((definition) => definition.id);
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      dupes.push(id);
    }
    seen.add(id);
  }
  assert.deepEqual(dupes, [], `duplicate ids in createHostRuntimeDefinitions(): ${dupes.join(", ")}`);
});

test("live drivers and the detect registry are the same set", () => {
  const driverIds = new Set(createHostDrivers().map((d) => d.id));
  const registryIds = new Set<string>(RAFT_DRIVER_REGISTRY);

  // Both directions, reported separately: they fail for different reasons and
  // a combined "sets differ" message would not say which way to look.
  const missingDriver = [...registryIds].filter((id) => !driverIds.has(id));
  assert.deepEqual(
    missingDriver,
    [],
    `registered but NOT built by createHostDrivers(): ${missingDriver.join(", ")} — ` +
      "detectAllRegistered will report these not_installed on every host, including hosts where they ARE installed",
  );

  const unregistered = [...driverIds].filter((id) => !registryIds.has(id));
  assert.deepEqual(
    unregistered,
    [],
    `built but NOT in RAFT_DRIVER_REGISTRY: ${unregistered.join(", ")} — ` +
      "these are detected by detectAll but never enumerated, so the adapter cannot ask about them",
  );
});

test("catalog and install views are derived from each runtime definition", () => {
  const definitionIds = new Set(createHostRuntimeDefinitions().map((definition) => definition.id));
  const catalogIds = new Set(createHostDrivers().map((driver) => driver.id));
  const installIds = new Set(createHostInstallTargets().map((target) => target.runtime));
  assert.deepEqual(catalogIds, definitionIds);
  assert.deepEqual(installIds, definitionIds);
});

test("a definition cannot construct a driver with another identity", () => {
  const [first] = createHostRuntimeDefinitions();
  if (!first) {
    assert.fail("host runtime registry must not be empty");
  }
  assert.throws(
    () => createDriverFromDefinition({ ...first, id: "identity-mismatch-control" }),
    /runtime definition identity mismatch/u,
  );
});

test("catalog/drive drivers do not carry install implementation fields", () => {
  for (const driver of createHostDrivers()) {
    assert.equal(
      "installAttempts" in driver,
      false,
      `${driver.id}: install detection must live in createHostInstallTargets(), not RuntimeDriver`,
    );
  }
});

test("both Kimi install identities are actually assembled", () => {
  // Redundant with the set equality above, kept because it names the specific
  // regression: the whole point of this card is that `kimi` and `kimi-cli` are
  // two live rows, and a failure here should say so rather than print a diff.
  const ids = new Set(createHostDrivers().map((d) => d.id));
  assert.ok(ids.has("kimi"), "canonical kimi (SDK) driver must be assembled");
  assert.ok(ids.has("kimi-cli"), "legacy kimi-cli driver must be assembled — the adapter's only source of the legacy row");
});
