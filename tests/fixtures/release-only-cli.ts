import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";

const [tool, ...args] = process.argv.slice(2);
const raw: unknown = JSON.parse(readFileSync(process.env.RECOVERY_SCENARIO ?? "", "utf8"));
assert.ok(raw !== null && typeof raw === "object" && !Array.isArray(raw));
const scenario: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
const commit = "a".repeat(40);
const tag = "b".repeat(40);
const record = (value: unknown): void => { appendFileSync(process.env.RECOVERY_CALLS ?? "", `${JSON.stringify(value)}\n`); };
const emit = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };

function ref(): void {
  if (scenario.missingTag === true) { process.exit(1); }
  const object = { type: scenario.lightweight === true ? "commit" : "tag", sha: scenario.lightweight === true ? commit : tag };
  if (args.includes("--jq")) { process.stdout.write(`${scenario.movedTag === true ? "c".repeat(40) : object.sha}\n`); }
  else { emit({ object }); }
}

function pulls(): void {
  const release = { title: "chore: release v0.80.2", merged_at: scenario.unmerged === true ? null : "2026-10-31T07:00:00Z",
    merge_commit_sha: scenario.wrongCommit === true ? "d".repeat(40) : commit,
    base: { ref: "main", repo: { full_name: "botiverse/oar" } }, body: notes() };
  const unrelated = { ...release, title: "unrelated main change", body: "Wrong notes" };
  if (scenario.nonReleasePr === true) { emit([[unrelated]]); return; }
  emit([scenario.ambiguous === true ? [release, release] : [unrelated, release]]);
}

function notes(): string | null {
  if (scenario.nullNotes === true) { return null; }
  if (scenario.emptyNotes === true) { return "<!-- stamp:review:v1 -->\nreview only\n<!-- /stamp:review:v1 -->"; }
  return "Tagged release notes\n<!-- stamp:review:v1 -->\nprivate review\n<!-- /stamp:review:v1 -->\nGenerated with [Claude Code]\n";
}

function manifest(endpoint: string): void {
  assert.ok(args.includes(`ref=${commit}`), "manifest must be read at the tagged commit");
  const data = { name: endpoint.includes("/cli/") ? "@botiverse/oar-cli" : "@botiverse/oar", version: scenario.manifestVersion ?? "0.80.2" };
  const content = Buffer.from(JSON.stringify(data)).toString("base64");
  // GitHub's content response wraps base64 with newlines.
  emit({ content: `${content.replaceAll(/(?<line>.{60})/gu, "$<line>\n")}\n` });
}

function api(): void {
  if (scenario.apiFailure === true) { process.exit(1); }
  const endpoint = args.find(arg => arg.startsWith("repos/")) ?? "";
  const routes: readonly [string, () => void][] = [
    ["/git/matching-refs/tags/", () => { process.stdout.write(scenario.existingTag === true ? "refs/tags/v0.80.2\n" : ""); }],
    ["/actions/workflows/ci.yml/runs", () => { emit({ status: "completed", conclusion: scenario.ciConclusion ?? "success" }); }],
    ["/git/ref/tags/", ref],
    ["/git/tags/", () => { emit({ object: { type: scenario.badObject === true ? "tree" : "commit", sha: commit } }); }],
    ["/contents/packages/", () => { manifest(endpoint); }],
    [`/commits/${commit}/pulls`, pulls],
  ];
  const matched = routes.find(([pattern]) => endpoint.includes(pattern));
  if (matched === undefined) { throw new Error(`unexpected API request: ${endpoint}`); }
  matched[1]();
}

record({ tool, args });
if (tool === "npm" && args[0] === "view") {
  if (scenario.npmFailure === true || (scenario.missingCli === true && args[1]?.includes("oar-cli") === true)) { process.exit(1); }
  emit(scenario.npmVersion ?? "0.80.2");
} else if (tool === "gh" && args[0] === "api") { api(); }
else if (tool === "gh" && args[0] === "release" && args[1] === "create") {
  record({ create: args, notes: readFileSync(args[args.indexOf("--notes-file") + 1] ?? "", "utf8") });
  if (scenario.existingRelease === true) { process.exit(1); }
} else { throw new Error(`unexpected mutation: ${tool} ${args.join(" ")}`); }
