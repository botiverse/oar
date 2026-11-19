import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { defaultRuntimes, dshRuntime, orient, RuntimeRegistry, type RuntimePlatform } from "../packages/oar/src/index.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { verifiedPlatforms } from "../packages/oar/src/platforms.js";

const runnerPlatform: Readonly<Record<string, RuntimePlatform>> = { "ubuntu-latest": "linux", "macos-latest": "darwin", "windows-latest": "win32" };

function platformsOf(runners: readonly unknown[]): RuntimePlatform[] {
  return runners.flatMap((runner) => {
    const platform = typeof runner === "string" ? runnerPlatform[runner] : undefined;
    return platform === undefined ? [] : [platform];
  });
}

function acpJobs(event: "push" | "pull_request"): Readonly<Record<string, unknown>>[] {
  const output = execFileSync(process.execPath, [".github/scripts/ci-select.mjs"], {
    encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: undefined, BASE_SHA: "" },
  });
  const matrix = output.split("\n").find(line => line.startsWith("acp="));
  if (matrix === undefined) { throw new Error("CI selector omitted the ACP matrix"); }
  const jobs: unknown = JSON.parse(matrix.slice("acp=".length));
  assert.ok(Array.isArray(jobs));
  return jobs.map((value: unknown) => {
    const job = asRecord(value);
    assert.ok(job);
    return job;
  });
}

/** The manifest's native backends, intersected with the actual ACP gate. Antigravity runs in the check job. */
function manifestPlatforms(): Map<string, RuntimePlatform[]> {
  const text = readFileSync(new URL("../.github/runtime-versions.json", import.meta.url), "utf8");
  const manifest = asRecord(JSON.parse(text));
  const entries = asRecord(manifest?.runtimes) ?? manifest ?? {};
  const jobs = acpJobs("push");
  const backends = Object.entries(entries).flatMap(([key, value]) => {
    const entry = asRecord(value);
    const runners: unknown = entry?.platforms;
    const verified = (entry?.suite === "behavior" || entry?.suite === "acp") && Array.isArray(runners);
    if (!verified) { return []; }
    const id = key.replace(/-(?:aimock|native)$/u, "");
    const gating = entry.suite === "acp" && id !== "antigravity"
      ? runners.filter(runner => jobs.some(job => job.os === runner && (job.suite ?? job.backend) === key))
      : runners;
    return [[id, platformsOf(gating)] as const];
  });
  return new Map(backends);
}

/** Runtimes whose behavior suite runs from the SDK dependency, so the manifest has no row for them (ci-select.mjs `behavior`). */
const sdkRuntimes: Readonly<Record<string, readonly RuntimePlatform[]>> = { pi: ["linux", "darwin", "win32"], "pi-durable": ["linux", "darwin", "win32"] };

test.each(["push", "pull_request"] as const)("the %s ACP gate runs both Windows OpenCode pins against the shared suite", event => {
  const windows = acpJobs(event).filter(job => job.os === "windows-latest");
  expect(windows.map(job => [job.suite ?? job.backend, job.pin ?? job.backend])).toEqual([
    ["opencode-aimock", "opencode-aimock"], ["opencode-aimock", "opencode-cleanup"],
  ]);
});

test("every built-in runtime declares exactly the platforms a gating CI job runs it on, and nothing else declares any", () => {
  const evidence = new Map([...manifestPlatforms(), ...Object.entries(sdkRuntimes).map(([id, platforms]) => [id, [...platforms]] as const)]);
  expect(evidence.size).toBeGreaterThan(5);
  for (const runtime of defaultRuntimes.list()) {
    const expected = evidence.get(runtime.id);
    expect([...(runtime.verifiedPlatforms ?? [])].toSorted(), runtime.id).toEqual(expected === undefined ? [] : expected.toSorted());
  }
  // The table (which createPiDurableRuntime also reads) has an entry for exactly the evidenced runtimes.
  expect(Object.keys(verifiedPlatforms).toSorted()).toEqual([...evidence.keys()].toSorted());
});

test("DSH declares the key it reads and every file that can supply it, in precedence order, with no value", () => {
  expect(dshRuntime.credentials).toEqual({
    env: [{ name: "DEEPSEEK_API_KEY", purpose: "api_key", secret: true }],
    stores: [
      { kind: "file", directoryEnv: "DSH_HOME", defaultDirectory: ".dsh", path: ".credentials.yaml", overridesEnv: true },
      { kind: "file", relativeTo: "cwd", path: ".env", overridesEnv: false },
      { kind: "file", directoryEnv: "DSH_HOME", defaultDirectory: ".dsh", path: ".env", overridesEnv: false },
    ],
  });
});

test("credential cleanup preserves each runtime's store directory overrides", () => {
  for (const runtime of defaultRuntimes.list()) {
    const env = new Set(runtime.credentials?.env?.map(variable => variable.name));
    for (const store of runtime.credentials?.stores ?? []) {
      if (store.directoryEnv !== undefined) {
        expect(env.has(store.directoryEnv), `${runtime.id} ${store.directoryEnv}`).toBe(false);
      }
    }
  }
});

test("orient carries platforms and credentials whether or not the runtime is installed", async () => {
  const missing = { ...dshRuntime, installation: async () => ({ kind: "not_found" as const }) };
  const report = await orient(new RuntimeRegistry([missing]));
  expect(report.runtimes[0]).toMatchObject({ verifiedPlatforms: dshRuntime.verifiedPlatforms, credentials: dshRuntime.credentials });
});
