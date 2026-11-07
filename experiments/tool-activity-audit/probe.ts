/* oxlint-disable eslint/no-await-in-loop -- Each observation depends on the previous native step. */
import { parseJson } from "../../packages/oar/src/shared/json.js";
/* oxlint-disable import/max-dependencies -- One experiment compares the native backends. */
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { defaultRuntimes, createPiRuntime, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { startClaudeAimock, startCodexAimock, startPiAimock, namespaceMcpToolCalls, type AimockEnv } from "../../sea-trial/harness/aimock.js";
import { startAntigravityAimock, startGrokAimock, startKimiAimock, startOpencodeAimock } from "../../sea-trial/harness/aimock-acp.js";
import { startCodebuddyAimock } from "../../sea-trial/harness/codebuddy-aimock.js";
import { startDshAimock } from "../../sea-trial/harness/dsh-aimock.js";
import { startQwenAimock } from "../../sea-trial/harness/qwen-aimock.js";
import { callFor, patchResponse, type Call } from "./calls.js";

const [runtimeId = "codex", output = "oar-trial-run/tool-activity", mode = "catalog"] = process.argv.slice(2);
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), "oar-tool-audit-"));
const cwd = path.join(root, "project");
await mkdir(cwd);
await writeFile(path.join(cwd, "audit.txt"), mode === "files" ? "BEFORE actual-file-evidence\n" : "BEFORE\n");
execFileSync("git", ["init", "--quiet", cwd]);
execFileSync("git", ["-C", cwd, "add", "audit.txt"]);
const journal = path.join(root, "mcp.jsonl");
const marks: unknown[] = [];
const mark = (kind: string, value?: unknown): void => { marks.push({ at: Date.now(), kind, value }); };
let stage = "catalog";
let stageRequests = 0;
let call: Call | undefined = callFor(runtimeId, stage, cwd);
const normalized: ChatCompletionRequest[] = [];
const configure = (mock: LLMock): void => {
  mock.on({ predicate: () => true }, request => {
    normalized.push(request);
    const primary = request.tools?.some(tool => tool.function.name === callFor(runtimeId, "command", cwd)?.name) === true;
    mark("provider_request", { stage, request: normalized.length, primary });
    if (!primary) { return { content: "Audit background summary" }; }
    if (++stageRequests === 1 && call !== undefined) { return { toolCalls: [{ ...call, id: `audit_${stage}` }] }; }
    return { content: `AUDIT_DONE_${stage}` };
  });
};
// oxlint-disable-next-line eslint/require-await -- Each branch returns an asynchronous native-provider fixture.
async function fixture(): Promise<AimockEnv> {
  switch (runtimeId) {
    case "claude": return startClaudeAimock(configure, { captureRaw: true });
    case "codex": return startCodexAimock(configure, { captureRaw: true, rewriteResponse: body => body.includes('"name":"apply_patch"') ? patchResponse(cwd) : namespaceMcpToolCalls(body) });
    case "pi": case "pi-rpc": return startPiAimock(configure, { captureRaw: true });
    case "antigravity": return startAntigravityAimock(configure);
    case "grok": return startGrokAimock(configure);
    case "kimi": return startKimiAimock(configure);
    case "opencode": return startOpencodeAimock(configure);
    case "codebuddy": return startCodebuddyAimock(configure);
    case "dsh": return startDshAimock({ configure });
    case "qwen": return startQwenAimock(configure);
    default: throw new Error(`Unsupported probe backend ${runtimeId}`);
  }
}
async function observeMcp(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await readFile(journal, "utf8").catch(() => "");
    if (value.includes('"tools_list_returned"')) { mark("mcp_observation_wait_ended"); return; }
    await delay(20);
  }
  throw new Error("MCP did not return tools/list");
}
function assertTools(current: Session, after: number): void {
  const ends = current.records().slice(after).flatMap(record => record.kind === "frame" ? record.body.events : []).filter(event => event.kind === "tool_call_ended");
  assert.ok(ends.length > 0 && ends.every(event => event.result !== "failed" && (event.exitCode === undefined || event.exitCode === 0)), JSON.stringify(ends));
}
function stages(): readonly string[] {
  if (mode === "catalog") { return ["catalog"]; }
  if (mode === "files") { return ["catalog", "read", "discover-file-search", "file-search"]; }
  return ["catalog", "command", "read", "edit", "search", "mcp"];
}
let session: Session | null = null;
let env: AimockEnv | null = null;
let failure: string | null = null;
let installation: unknown = null;
try {
  env = await fixture();
  const runtime = runtimeId === "pi-rpc" ? createPiRuntime({ execution: "subprocess" }) : defaultRuntimes.require(runtimeId);
  assert.ok(runtime.installation !== undefined);
  const detected = await runtime.installation();
  installation = detected;
  if (detected.kind !== "available") { throw new Error(`Unavailable ${runtimeId}`); }
  const isolatedHome = path.join(root, "home");
  await mkdir(isolatedHome);
  mark("open_start");
  session = await runtime.session(detected, {
    cwd, env: { ...(runtimeId === "claude" ? { HOME: isolatedHome, CLAUDE_CONFIG_DIR: path.join(isolatedHome, ".claude"), ANTHROPIC_AUTH_TOKEN: "" } : {}), ...env.env },
    ...(runtimeId === "codex" ? { model: "gpt-5.5" } : {}),
    ...(runtimeId.startsWith("pi") ? { model: "aimock/aimock-model" } : {}),
    ...(runtimeId === "codebuddy" ? { launchArgs: ["--model", "deepseek-flash"] } : {}),
    mcpServers: [{ name: "audit", command: process.execPath, args: [path.join(import.meta.dirname, "server.ts"), journal, "2000"] }],
  });
  mark("open_returned");
  for (const next of stages()) {
    stage = next; stageRequests = 0;
    call = callFor(runtimeId, stage, cwd);
    if (stage === "catalog" || call !== undefined) {
      const cursor: number = session.records().length;
      const firstRequest = normalized.length;
      mark("prompt_start", stage);
      const result = await promptAndWait(session, `AUDIT_${stage.toUpperCase()}`, { timeoutMs: 60_000 });
      mark("prompt_returned", result);
      assert.ok(result.kind === "ended" && result.outcome.kind === "completed", JSON.stringify(result));
      if (call !== undefined) { assertTools(session, cursor); }
      if (mode === "files" && (stage === "read" || stage === "file-search")) {
        const results = normalized.slice(firstRequest).flatMap(request => request.messages.filter(message => message.role === "tool" && message.tool_call_id === `audit_${next}`));
        assert.ok(JSON.stringify(results).includes("actual-file-evidence"), `Missing actual file result: ${JSON.stringify(results)}`);
      }
      if (stage === "catalog" && mode !== "catalog") { await observeMcp(); }
      if (stage === "edit") { const value = await readFile(path.join(cwd, "audit.txt"), "utf8"); mark("file_after_edit", value); assert.equal(value, "AFTER\n"); }
    }
  }
} catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); }
finally {
  const records = session?.records() ?? [];
  const mcp = await readFile(journal, "utf8").then(value => value.trim().split("\n").map(line => parseJson(line)), () => []);
  await writeFile(path.join(output, `${runtimeId}.json`), JSON.stringify({ runtimeId, installation, mode, root, cwd, marks, failure, mcp, records, normalized, raw: env?.raw }, null, 2));
  await session?.dispose();
  await env?.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(JSON.stringify({ runtimeId, failure, file: path.join(output, `${runtimeId}.json`), tools: normalized[0]?.tools?.map(tool => tool.function.name) }));
if (failure !== null) { process.exitCode = 1; }
