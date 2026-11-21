import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "vitest";
import { acceptedPiVersions, checkPiManifestConsistency, satisfiesPublishedRange } from "./fixtures/clean-install-pins.js";

test("CI candidate scripts preserve failures and install only the frozen local fixture", () => {
  const result = spawnSync(process.execPath,
    ["--test", "--test-reporter=tap", ".github/scripts/runtime-ci.test.mjs"], { encoding: "utf8", timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toMatch(/# fail 0/u);
}, 100_000);

test("the gate derives Pi and undici pins from the actual accepted workspace graph", () => {
  const versions = acceptedPiVersions(path.resolve("."));
  expect(Object.keys(versions)).toEqual(expect.arrayContaining([
    "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-durable", "@earendil-works/chord", "undici",
  ]));
  expect(Object.values(versions).every(version => /^\d+\.\d+\.\d+$/u.test(version))).toBe(true);
});

test.each([
  ["1.5.2", "^1.5.2", true], ["1.6.0", "^1.5.2", true], ["2.0.0", "^1.5.2", false],
  ["1.5.1", "^1.5.2", false], ["1.5.3", "~1.5.2", true], ["1.6.0", "~1.5.2", false],
  ["0.2.1", "^0.2.0", true], ["0.3.0", "^0.2.0", false], ["0.0.2", "^0.0.1", false],
  ["1.5.2", "1.5.2", true], ["1.5.3", "1.5.2", false],
])("accepted version %s satisfies published %s: %s", (version, range, expected) => {
  expect(satisfiesPublishedRange(version, range)).toBe(expected);
});

test("an unknown published range cannot silently admit a baseline", () => {
  expect(() => satisfiesPublishedRange("1.5.2", ">=1.0.0")).toThrow("Unsupported Pi baseline/range");
});

function sampleManifests(overrides: {
  readonly oarOptional?: Record<string, string>;
  readonly oarPeers?: Record<string, string>;
  readonly oarUndici?: string;
  readonly cliDeps?: Record<string, string>;
  readonly piUndici?: string;
} = {}) {
  return {
    oar: {
      dependencies: { undici: overrides.oarUndici ?? "8.12.3" },
      optionalDependencies: { "@earendil-works/pi-ai": "~1.5.2", "@earendil-works/pi-coding-agent": "~1.5.2", ...overrides.oarOptional },
      peerDependencies: { "@earendil-works/pi-durable": "~1.5.2", "@earendil-works/chord": "~1.5.2", ...overrides.oarPeers },
    },
    cli: { dependencies: { "@earendil-works/pi-ai": "~1.5.2", "@earendil-works/pi-coding-agent": "~1.5.2", ...overrides.cliDeps } },
    pi: { dependencies: { undici: overrides.piUndici ?? "8.12.3" } },
  };
}

test("Pi manifest consistency accepts matching tilde or exact ranges with matching exact undici", () => {
  const tilde = sampleManifests();
  expect(() => { checkPiManifestConsistency(tilde.oar, tilde.cli, tilde.pi); }).not.toThrow();
  const exact = sampleManifests({
    oarOptional: { "@earendil-works/pi-ai": "1.6.0", "@earendil-works/pi-coding-agent": "1.6.0" },
    oarPeers: { "@earendil-works/pi-durable": "1.6.0", "@earendil-works/chord": "1.6.0" },
    cliDeps: { "@earendil-works/pi-ai": "1.6.0", "@earendil-works/pi-coding-agent": "1.6.0" },
    oarUndici: "8.12.4",
    piUndici: "8.12.4",
  });
  expect(() => { checkPiManifestConsistency(exact.oar, exact.cli, exact.pi); }).not.toThrow();
});

test("Pi manifest consistency rejects mismatched ranges, caret ranges, and mismatched undici", () => {
  const splitOar = sampleManifests({ oarOptional: { "@earendil-works/pi-coding-agent": "^1.5.2" } });
  expect(() => { checkPiManifestConsistency(splitOar.oar, splitOar.cli, splitOar.pi); }).toThrow(/Pi family range mismatch/u);
  const splitCli = sampleManifests({ cliDeps: { "@earendil-works/pi-ai": "^1.5.2" } });
  expect(() => { checkPiManifestConsistency(splitCli.oar, splitCli.cli, splitCli.pi); }).toThrow(/Pi family range mismatch/u);
  const caretAll = sampleManifests({
    oarOptional: { "@earendil-works/pi-ai": "^1.5.2", "@earendil-works/pi-coding-agent": "^1.5.2" },
    oarPeers: { "@earendil-works/pi-durable": "^1.5.2", "@earendil-works/chord": "^1.5.2" },
    cliDeps: { "@earendil-works/pi-ai": "^1.5.2", "@earendil-works/pi-coding-agent": "^1.5.2" },
  });
  expect(() => { checkPiManifestConsistency(caretAll.oar, caretAll.cli, caretAll.pi); }).toThrow(/must be ~X\.Y\.Z or exact X\.Y\.Z/u);
  const splitUndici = sampleManifests({ oarUndici: "8.12.3", piUndici: "8.12.4" });
  expect(() => { checkPiManifestConsistency(splitUndici.oar, splitUndici.cli, splitUndici.pi); }).toThrow(/dependencies\.undici/u);
});
