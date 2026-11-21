import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { asRecord } from "../packages/oar/src/shared/json.js";

function reach(file: string): unknown {
  const result = spawnSync(process.execPath, [".github/scripts/ci-select.mjs", "reach", file], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const parsed: unknown = JSON.parse(result.stdout);
  return parsed;
}

function select(event: "push" | "pull_request"): Readonly<Record<string, string>> {
  const result = spawnSync(process.execPath, [".github/scripts/ci-select.mjs"], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: undefined, BASE_SHA: "" },
  });
  expect(result.status, result.stderr).toBe(0);
  return Object.fromEntries(result.stdout.trim().split("\n").map((line) => {
    const eq = line.indexOf("=");
    return [line.slice(0, eq), line.slice(eq + 1)];
  }));
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

test("push and PR selection keep only Linux plus audit-proven non-Linux jobs", () => {
  const push = select("push");
  const pushBehavior: unknown = JSON.parse(push.behavior ?? "[]");
  const nonLinux = (Array.isArray(pushBehavior) ? pushBehavior : [])
    .map((entry) => asRecord(entry))
    .filter((job) => job?.os !== "ubuntu-latest");
  expect(nonLinux).toEqual([
    { os: "windows-latest", backend: "codex-aimock" },
    { os: "windows-latest", backend: "dsh-aimock" },
  ]);
  expect(push.pi_rpc_windows).toBe("true");
  const pr = select("pull_request");
  const prBehavior: unknown = JSON.parse(pr.behavior ?? "[]");
  expect((Array.isArray(prBehavior) ? prBehavior : []).every((job) => asRecord(job)?.os === "ubuntu-latest")).toBe(true);
  expect(pr.pi_rpc_windows).toBe("false");
});

test("daily shards match platform-matrix.yml", () => {
  const shardsResult = spawnSync(process.execPath, [".github/scripts/ci-select.mjs", "shards"], { encoding: "utf8" });
  expect(shardsResult.status, shardsResult.stderr).toBe(0);
  const shards = asRecord(JSON.parse(shardsResult.stdout)) ?? {};
  const workflow = readFileSync(".github/workflows/platform-matrix.yml", "utf8");
  for (const shard of Object.keys(shards)) {
    expect(workflow).toContain(`shard: ${shard}`);
  }
});

test("run-ci-shard rejects unknown shard names", () => {
  const result = spawnSync(process.execPath, [".github/scripts/run-ci-shard.mjs", "no-such-shard"], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Unknown shard");
});
