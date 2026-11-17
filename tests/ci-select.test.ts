import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

function reach(file: string): unknown {
  const result = spawnSync(process.execPath, [".github/scripts/ci-select.mjs", "reach", file], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const parsed: unknown = JSON.parse(result.stdout);
  return parsed;
}

test.each([
  // A probe the DSH vendor test imports must not be treated as inert.
  ["experiments/dsh-option-boundaries/native-probe.ts", null],
  ["experiments/sharing/grok-candidate.ts", null],
  ["experiments/dsh-option-boundaries/README.md", []],
  ["docs/spec/runtime-matrix.md", []],
  ["packages/oar/src/runtimes/qwen/skills.ts", ["qwen-aimock"]],
  ["sea-trial/vendor/dsh-skills.vendor.test.ts", ["dsh-aimock"]],
  [".github/runtime-versions.json", null],
])("%s reaches %j", (file, expected) => {
  expect(reach(file)).toEqual(expected);
});
