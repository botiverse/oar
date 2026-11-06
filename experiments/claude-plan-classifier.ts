/* oxlint-disable eslint/no-await-in-loop -- Compare synthetic classifier answers in isolated sessions. */
/**
 * Compare Claude's plan-mode Bash permission paths with a local provider.
 * OAR_CLAUDE_BIN=/path/to/claude pnpm tsx experiments/claude-plan-classifier.ts <output.json> [0]
 * Omit 0 to remove CLAUDE_CODE_AUTO_MODE_SERVER; pass 0 to select the built-in classifier.
 * See claude-permissions/2026-11-06.md. Raw output includes local paths; do not publish it.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeRuntime, promptAndWait, type Session } from "../packages/oar/src/index.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { startClaudeAimock } from "../sea-trial/harness/aimock.js";

const [output, autoModeServer] = process.argv.slice(2);
assert.ok(autoModeServer === undefined || autoModeServer === "0", "optional auto mode server must be 0");
assert.ok(output !== undefined, "usage: OAR_CLAUDE_BIN=<binary> tsx claude-plan-classifier.ts <output.json> [0]");
const installation = await claudeRuntime.installation();
assert.ok(installation.kind === "available" && installation.via === "executable");
const results: unknown[] = [];
for (const severity of [0, 90]) {
  const temporary = await mkdtemp(path.join(tmpdir(), "oar-plan-classifier-"));
  const directory = await realpath(temporary);
  const script = path.join(directory, "write-fixture.cjs");
  const file = path.join(directory, "proof.txt");
  const marker = "OAR_PLAN_CLASSIFIER_PROOF";
  await writeFile(script, 'require("node:fs").writeFileSync(process.argv[2], process.argv[3]);\n');
  let ordinaryCalls = 0;
  let classifierCalls = 0;
  const fixture = await startClaudeAimock((mock) => {
    mock.onMessage(/[\s\S]*/u, (request) => {
      if (JSON.stringify(request.messages).includes("<severity>")) {
        classifierCalls++;
        return { content: `<severity>${String(severity)}</severity>` };
      }
      const latest = request.messages.findLast((message) => message.role === "user" && JSON.stringify(message.content).includes(marker));
      if (latest === undefined) { return { content: "metadata" }; }
      ordinaryCalls++;
      const command = [process.execPath, script, file, marker].map((argument) => `'${argument.replaceAll("\\", "/").replaceAll("'", String.raw`'\''`)}'`).join(" ");
      return ordinaryCalls === 1 ? { toolCalls: [{ id: "plan-bash", name: "Bash", arguments: JSON.stringify({ command }) }] } : { content: "finished" };
    });
  }, { captureRaw: true });
  let session: Session | null = null;
  try {
    session = await claudeRuntime.session(installation, {
      cwd: directory, model: "sonnet",
      env: { ...fixture.env, HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: path.join(directory, ".claude"),
        ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_AUTO_MODE_SERVER: autoModeServer ?? null },
      launchArgs: ["--settings", '{"disableAllHooks":true}', "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-mode=plan"],
    });
    const outcome = await promptAndWait(session, marker, { timeoutMs: 25_000 });
    assert.equal(outcome.kind, "ended");
    const written = await readFile(file, "utf8").then((value) => value === marker, (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") { return false; }
      throw error;
    });
    const decisions = session.records().flatMap((record) => {
      if (record.kind !== "frame") { return []; }
      const metadata = asRecord(record.body.native)?.tool_result_meta;
      return Array.isArray(metadata) ? metadata.map((entry: unknown) => {
        const item = asRecord(entry);
        return { nonExecutionKind: item?.non_execution_kind ?? null, permissionDecision: item?.permission_decision };
      }) : [];
    });
    const observation = { severity, classifierCalls, ordinaryCalls, capturedRequests: fixture.raw.length, written, decisions,
      outcome: outcome.outcome.kind,
      permissionRequests: session.records().filter((record) => record.kind === "request" && record.direction === "toApp").length,
    };
    results.push(observation);
    await writeFile(`${output}.${String(severity)}.raw.json`, `${JSON.stringify({ requests: fixture.raw, records: session.records() }, null, 2)}\n`);
    console.log(JSON.stringify(observation));
    await writeFile(output, `${JSON.stringify({ version: installation.version, platform: `${process.platform} ${process.arch}`, provider: "local scripted", autoModeServer: autoModeServer ?? "unset", results }, null, 2)}\n`);
  } finally {
    await session?.dispose();
    await fixture.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}
