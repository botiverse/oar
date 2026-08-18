import assert from "node:assert/strict";
import test from "node:test";
import {
  createHostDrivers,
  createHostInstallTargets,
} from "./runtimeDrivers.js";
import { RAFT_DRIVER_REGISTRY } from "../fixtures/raftRuntimes.js";

/**
 * Live assembly parity: what `createHostDrivers()` actually builds must be
 * exactly what `RAFT_DRIVER_REGISTRY` enumerates.
 *
 * Found by Huaihuai's reviewer mutation on 96d38dd, and it is a hole I left:
 * deleting `kimiCliDriver()` from createHostDrivers() (with its import, so
 * typecheck stays clean) left EVERYTHING green — 97 tests, all three teeth
 * suites, library-exports still reporting a non-zero driver count.
 *
 * Nothing bit because every existing check looked at the wrong object:
 *   registry/fixture teeth  assert RAFT_DRIVER_REGISTRY and the fixtures contain
 *                           `kimi-cli` — both are literals, unaffected by the
 *                           assembly
 *   library-exports tooth   asserts the driver count is non-zero, not which
 *   detect matrix teeth     construct their drivers directly, bypassing the
 *                           assembly entirely
 *
 * And the consequence is silent rather than loud: `detectAllRegistered()` emits
 * a row per registryId regardless of whether a driver owns it, so a missing
 * driver does not disappear — it comes back as a confident `not_installed`. A
 * host with the Kimi CLI genuinely installed would be reported as not having
 * it, permanently, with no error anywhere.
 *
 * This is the same defect shape as three earlier ones on this card: an
 * assertion placed on a value derived from the test's own input rather than on
 * the production object. Hence this file asserts on `createHostDrivers()`
 * itself.
 */

test("no driver id is registered twice in the live assembly", () => {
  const ids = createHostDrivers().map((d) => d.id);
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  assert.deepEqual(dupes, [], `duplicate driver ids in createHostDrivers(): ${dupes.join(", ")}`);
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

test("catalog drivers and install targets cover the same runtime identities", () => {
  const catalogIds = createHostDrivers().map((driver) => driver.id);
  const installIds = createHostInstallTargets().map((target) => target.runtime);
  assert.deepEqual(installIds, catalogIds);
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
