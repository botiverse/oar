import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { asRecord } from "../packages/oar/src/shared/json.js";

const quote = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;

function readBlock(workflow: string, marker: string, indent: number): string {
  const [, after] = workflow.split(marker);
  expect(after, marker).toBeDefined();
  const lines: string[] = [];
  for (const line of after?.split("\n") ?? []) {
    if (line.length > 0 && !line.startsWith(" ".repeat(indent))) { break; }
    lines.push(line.slice(indent));
  }
  return lines.join("\n");
}

async function workflowScripts(): Promise<{ readonly filter: string; readonly gate: string; readonly recovery: string; readonly raw: string }> {
  const raw = await readFile(".github/workflows/release.yml", "utf8");
  const filter = readBlock(raw, "  RELEASE_PR_FILTER: |\n", 4);
  const [, publishJob] = raw.split("\n  publish:\n");
  const gate = readBlock(publishJob ?? "", "        run: |\n", 10);
  const [, recoveryJob] = raw.split("\n  release_only:\n");
  const recovery = readBlock(recoveryJob ?? "", "        run: |\n", 10);
  return { filter, gate, recovery, raw };
}

async function prepare(directory: string, scenario: Record<string, unknown>, filter: string): Promise<NodeJS.ProcessEnv> {
  const fixture = path.resolve("tests/fixtures/release-only-cli.ts");
  await Promise.all(["gh", "npm"].map(async tool => writeFile(path.join(directory, tool),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} ${tool} "$@"\n`, { mode: 0o700 })));
  const scenarioFile = path.join(directory, "scenario.json");
  await writeFile(scenarioFile, JSON.stringify(scenario));
  return { ...process.env, GH_TOKEN: "", PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
    GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "botiverse/oar", GITHUB_SHA: "a".repeat(40),
    TAG: "v0.80.2", RELEASE_PR_FILTER: filter,
    RECOVERY_SCENARIO: scenarioFile, RECOVERY_CALLS: path.join(directory, "calls.jsonl") };
}

async function execute(script: string, directory: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  const result = Promise.withResolvers<{ ok: boolean; output: string }>();
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Adapt Node's callback API while retaining failed command output.
  execFile("bash", ["-c", script], { cwd: directory, timeout: 15_000, env }, (error, stdout, stderr) => {
    result.resolve({ ok: error === null, output: `${stdout}\n${stderr}\n${error?.message ?? ""}` });
  });
  return result.promise;
}

// Execute the actual bash step with command responses controlled at the network boundary.
// The job itself runs only on ubuntu-latest; other systems do not need bash/jq installed.
async function runStep(
  step: "gate" | "recovery",
  scenario: Record<string, unknown> = {},
  env: Record<string, string> = {},
): Promise<{ ok: boolean; calls: ReturnType<typeof asRecord>[]; output: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oar-release '"));
  try {
    const scripts = await workflowScripts();
    const prepared = await prepare(directory, scenario, scripts.filter);
    const result = await execute(scripts[step], directory, { ...prepared, ...env });
    const log = await readFile(path.join(directory, "calls.jsonl"), "utf8").catch(() => "");
    return { ...result, calls: log.trim().split("\n").filter(Boolean).map(line => asRecord(JSON.parse(line))) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const recovery = async (scenario: Record<string, unknown> = {}, env: Record<string, string> = {}): ReturnType<typeof runStep> => {
  const result = await runStep("recovery", scenario, env);
  return result;
};

const dispatchGate = async (scenario: Record<string, unknown> = {}, env: Record<string, string> = {}): ReturnType<typeof runStep> => {
  const result = await runStep("gate", scenario, env);
  return result;
};

test("publish declares pull-requests: read and shares RELEASE_PR_FILTER with release_only", async () => {
  const { gate, recovery: recoveryCode, raw } = await workflowScripts();
  const publishPermissions = readBlock(raw.split("\n  publish:\n")[1] ?? "", "    permissions:\n", 6);
  expect(publishPermissions).toContain("pull-requests: read");
  expect(gate).toContain('"$RELEASE_PR_FILTER"');
  expect(recoveryCode).toContain('"$RELEASE_PR_FILTER"');
});

test.skipIf(process.platform !== "linux")("dispatch gate accepts a matching merged release PR whose CI succeeded", async () => {
  const result = await dispatchGate();
  expect(result.ok, result.output).toBe(true);
  expect(result.calls.map(call => call?.args)).toEqual([
    ["api", "repos/botiverse/oar/git/matching-refs/tags/v0.80.2", "--jq", '.[] | select(.ref == "refs/tags/v0.80.2") | .ref'],
    ["api", "--paginate", "--slurp", `repos/botiverse/oar/commits/${"a".repeat(40)}/pulls?per_page=100`],
    ["api", `repos/botiverse/oar/actions/workflows/ci.yml/runs?head_sha=${"a".repeat(40)}`, "--jq", '[.workflow_runs[] | select(.event == "push" or .event == "workflow_dispatch") | {status, conclusion}] | first // empty'],
  ]);
});

test.skipIf(process.platform !== "linux").each([
  { nonReleasePr: true }, { wrongCommit: true }, { unmerged: true }, { ambiguous: true },
  { nullNotes: true }, { apiFailure: true }, { existingTag: true },
])("dispatch gate refuses non-release or mismatched commits before polling CI: %j", async scenario => {
  const result = await dispatchGate(scenario);
  expect(result.ok, result.output).toBe(false);
  expect(result.calls.some(call => JSON.stringify(call).includes("/actions/workflows/ci.yml/runs"))).toBe(false);
});

test.skipIf(process.platform !== "linux").each([false, true])("recovery uses the tagged commit's release notes (lightweight=%s)", async lightweight => {
  const result = await recovery({ lightweight });
  expect(result.ok, result.output).toBe(true);
  expect(result.calls.filter(call => call?.create !== undefined)).toEqual([{
    create: ["release", "create", "v0.80.2", "--repo", "botiverse/oar", "--title", "v0.80.2", "--notes-file", "notes.md", "--verify-tag"],
    notes: "Tagged release notes\n\n",
  }]);
  expect(result.calls.filter(call => call?.tool === "npm").map(call => call?.args)).toEqual([
    ["view", "@botiverse/oar@0.80.2", "version", "--json", "--registry=https://registry.npmjs.org"],
    ["view", "@botiverse/oar-cli@0.80.2", "version", "--json", "--registry=https://registry.npmjs.org"],
  ]);
});

test.skipIf(process.platform !== "linux").each([
  { missingTag: true }, { apiFailure: true }, { badObject: true },
  { manifestVersion: "0.80.1" }, { missingCli: true }, { npmFailure: true }, { npmVersion: "0.81.0" },
  { wrongCommit: true }, { unmerged: true }, { ambiguous: true }, { emptyNotes: true }, { nullNotes: true }, { movedTag: true },
])("recovery refuses incomplete or inconsistent publication evidence: %j", async scenario => {
  const result = await recovery(scenario);
  expect(result.ok, result.output).toBe(false);
  expect(result.calls.filter(call => call?.create !== undefined)).toEqual([]);
});

test.skipIf(process.platform !== "linux").each([
  { GITHUB_REF: "refs/heads/feature" }, { TAG: "v0.80.2; touch forbidden" },
])("recovery rejects an invalid dispatch before any network command: %j", async env => {
  const result = await recovery({}, env);
  expect(result.ok, result.output).toBe(false);
  expect(result.calls).toEqual([]);
});

test.skipIf(process.platform !== "linux")("recovery retains a release creation error instead of republishing or retagging", async () => {
  const result = await recovery({ existingRelease: true });
  expect(result.ok).toBe(false);
  expect(result.calls.filter(call => call?.create !== undefined)).toHaveLength(1);
  expect(result.calls.at(-1)?.create).toEqual(expect.arrayContaining(["--verify-tag"]));
});
