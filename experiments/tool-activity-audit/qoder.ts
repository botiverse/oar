/* oxlint-disable eslint/no-await-in-loop -- Each observation depends on the previous native step. */
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promptAndWait, qoderInstallation, qoderSession, type Session } from "../../packages/oar/src/index.js";
import { startQoderNative } from "../../sea-trial/harness/qoder-native.js";
import { callFor } from "./calls.js";

const output = process.argv[2] ?? "oar-trial-run/tool-activity";
const files = process.argv[3] === "files";
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), "oar-qoder-tool-audit-"));
const target = path.join(root, "audit.txt");
const journal = path.join(root, "mcp.jsonl");
await writeFile(target, files ? "BEFORE actual-file-evidence\n" : "BEFORE\n");
const stages = files ? ["read", "file-search"] : ["command", "read", "edit", "mcp"];
const replies = stages.flatMap(stage => {
  const call = callFor("qoder", stage, root);
  assert.ok(call !== undefined);
  return [{ tool: { name: call.name, args: asRecord(parseJson(call.arguments)) ?? {} } }, { text: `AUDIT_DONE_${stage}` }];
});
const fixture = await startQoderNative(replies);
const installation = await qoderInstallation();
assert.ok(installation.kind === "available");
const marks: unknown[] = [];
const mark = (kind: string, value?: unknown): void => { marks.push({ at: Date.now(), kind, value }); };
function assertFileResult(current: Session, after: number): void {
  const events = current.records().slice(after).flatMap(record => record.kind === "frame" ? record.body.events : []);
  const ends = events.filter(event => event.kind === "tool_call_ended");
  assert.ok(ends.length > 0 && ends.every(event => event.result === "ok"), JSON.stringify(ends));
  assert.ok(JSON.stringify(ends).includes("actual-file-evidence"), "Native result must contain file evidence");
}
let session: Session | null = null;
let failure: string | null = null;
try {
  mark("open_start");
  session = await qoderSession(installation, { ...fixture.options, cwd: root, model: "efficient",
    mcpServers: [{ name: "audit", command: process.execPath, args: [path.join(import.meta.dirname, "server.ts"), journal, "2000"] }],
  });
  mark("open_returned");
  for (const stage of stages) {
    const cursor: number = session.records().length;
    mark("prompt_start", stage);
    const result = await promptAndWait(session, `AUDIT_${stage}`, { timeoutMs: 30_000 });
    mark("prompt_returned", result);
    assert.ok(result.kind === "ended" && result.outcome.kind === "completed");
    if (files) { assertFileResult(session, cursor); }
    if (stage === "edit") { const value = await readFile(target, "utf8"); mark("file_after_edit", value); assert.equal(value, "AFTER\n"); }
  }
} catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); }
finally {
  const mcp = await readFile(journal, "utf8").then(value => value.trim().split("\n").map(line => parseJson(line)), () => []);
  await writeFile(path.join(output, "qoder.json"), JSON.stringify({ runtimeId: "qoder", installation, mode: "native-replay", root, marks, failure, mcp, records: session?.records() ?? [] }, null, 2));
  await session?.dispose(); await fixture.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(JSON.stringify({ runtimeId: "qoder", failure }));
if (failure !== null) { process.exitCode = 1; }
