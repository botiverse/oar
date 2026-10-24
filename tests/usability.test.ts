import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { usability, utcInstantFromDate, type Orientation, type Probe, type RuntimeOrientation } from "../packages/oar/src/index.js";

function ok<T>(value: T): Probe<T> {
  const observedAt = utcInstantFromDate(new Date("2026-10-23T00:00:00.000Z"));
  assert.ok(observedAt);
  return { kind: "ok", value, observedAt };
}
function fixture(overrides: Partial<RuntimeOrientation> = {}): Orientation {
  const observedAt = utcInstantFromDate(new Date("2026-10-23T00:00:00.000Z"));
  assert.ok(observedAt);
  return { depth: "local", observedAt, runtimes: [{
    id: "fixture", brand: { name: "Fixture", icon: null },
    installation: ok({ kind: "available", via: "executable", command: "fixture", version: "1.2.3" }),
    auth: ok({ kind: "logged_in", source: "native" }), ...overrides,
  }] };
}

test.each([
  [{}, undefined],
  [{ installation: ok({ kind: "not_found" }) }, "not_installed"],
  [{ installation: { kind: "unsupported" } }, "probe_failed"],
  [{ auth: ok({ kind: "logged_out", source: "native" }) }, "logged_out"],
  [{ auth: { kind: "unsupported" } }, "auth_unknown"],
  [{ accountUsage: ok({ kind: "available", rateLimited: true, windows: [] }) }, "rate_limited"],
  [{ accountUsage: ok({ kind: "reauth_required" }) }, "logged_out"],
  [{ models: { kind: "skipped", because: "logged_out" } }, "logged_out"],
  [{ auth: { kind: "unsupported" }, providers: ok([{ providerId: "plan", configured: true, method: "oauth", subscription: true }]) }, undefined],
  [{ auth: { kind: "unsupported" }, providers: ok([]) }, "auth_unknown"],
] satisfies readonly (readonly [Partial<RuntimeOrientation>, string | undefined])[])("projects readiness from native facts: %j", (overrides, because) => {
  const snapshot = fixture(overrides);
  const before = JSON.stringify(snapshot);
  expect(usability(snapshot)).toEqual([{ id: "fixture", usable: because === undefined, ...(because === undefined ? {} : { because }) }]);
  expect(JSON.stringify(snapshot)).toBe(before);
});

test.each([
  ["1.2.2", true], ["1.2.3", true], ["1.2.4", false], ["1.2.3-rc.2", true],
])("host minimum %s is checked without an OAR version policy", (minimum, usable) => {
  expect(usability(fixture(), { minVersions: { fixture: minimum } })[0]?.usable).toBe(usable);
});

test.each([["1.2.3-rc.2", "1.2.3-rc.10", false], ["1.2.3-rc.10", "1.2.3-rc.2", true], ["1.2.3-rc.2", "1.2.3", false]])("prerelease %s compared with %s", (actual, minimum, usable) => {
  const snapshot = fixture({ installation: ok({ kind: "available", via: "executable", command: "fixture", version: actual }) });
  expect(usability(snapshot, { minVersions: { fixture: minimum } })[0]?.usable).toBe(usable);
});

test("a bundled or unparseable version cannot satisfy a host's explicit minimum", () => {
  const snapshot = fixture({ installation: ok({ kind: "available", via: "bundled" }) });
  expect(usability(snapshot, { minVersions: { fixture: "1.0.0" } })[0]?.because).toBe("version_unsupported");
  expect(() => usability(fixture(), { minVersions: { fixture: "latest" } })).toThrow(RangeError);
});
