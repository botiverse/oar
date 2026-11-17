import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "vitest";
import { acceptedPiVersions, satisfiesPublishedRange } from "./fixtures/clean-install-pins.js";

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
