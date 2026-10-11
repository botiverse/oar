/* oxlint-disable no-await-in-loop -- Each native case is independent and the logs keep its order. */
/** Native JSON schema channels and result/failure frames, real binaries and a local provider only. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeSession } from "../packages/oar/src/runtimes/claude/session.js";
import { startAppServerClient } from "../packages/oar/src/runtimes/codex/app-server-client.js";
import { promptAndWait } from "../packages/oar/src/observe/turns.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { startClaudeAimock, startCodexAimock } from "../sea-trial/harness/aimock.js";

const schema = { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false };
const root = await mkdtemp(path.join(tmpdir(), "oar-structured-"));
const output = path.resolve(process.argv[3] ?? "oar-trial-run/structured-output");
await mkdir(output, { recursive: true });

async function claude(mode: "valid" | "invalid" | "bad-schema"): Promise<void> {
  const provider = await startClaudeAimock((mock) => {
    mock.onMessage(/[\s\S]*/u, { toolCalls: [{ name: "StructuredOutput", arguments: JSON.stringify({ answer: mode === "invalid" ? "wrong" : 4 }) }] });
  }, { captureRaw: true });
  try {
    const session = await claudeSession({ kind: "available", via: "executable", command: process.env.OAR_CLAUDE_BIN ?? "claude" }, {
      cwd: root, env: { ...provider.env, CLAUDE_CONFIG_DIR: path.join(root, mode), ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null },
      outputSchema: mode === "bad-schema" ? { type: "not-a-type" } : schema,
    });
    try {
      const result = await promptAndWait(session, "Report the answer using StructuredOutput", { timeoutMs: 20_000 });
      const frames = session.records().filter((r) => r.kind === "frame").map((r) => r.body.native);
      await writeFile(path.join(output, `claude-${mode}.jsonl`), `${frames.map((r) => JSON.stringify(r).replaceAll(root, "<TMP>")).join("\n")}\n`);
      const tools = asRecord(provider.raw[0]?.body)?.tools;
      const outputTool: unknown = Array.isArray(tools) ? tools.find((tool: unknown) => asRecord(tool)?.name === "StructuredOutput") : undefined;
      console.log(JSON.stringify({ runtime: "claude", mode, result, calls: provider.raw.length,
        resultFrames: frames.filter((r) => asRecord(r)?.type === "result"),
        outputTool }).replaceAll(root, "<TMP>"));
    } finally { await session.dispose(); }
  } finally { await provider.stop(); }
}

async function codex(mode: "valid" | "invalid" | "bad-json" | "schema-error"): Promise<void> {
  const provider = await startCodexAimock((mock) => {
    mock.onMessage(/[\s\S]*/u, mode === "schema-error"
      ? { error: { type: "invalid_request_error", message: "Invalid schema for response_format 'output'" }, status: 400 }
      : { content: mode === "bad-json" ? "not JSON" : JSON.stringify({ answer: mode === "invalid" ? "wrong" : 4 }) });
  }, { captureRaw: true });
  const client = startAppServerClient(process.env.OAR_CODEX_BIN ?? "codex", provider.env, { sandbox_mode: '"danger-full-access"' });
  const frames: unknown[] = [];
  const end = Promise.withResolvers<void>();
  const timer = setTimeout(() => { end.reject(new Error("Codex turn did not end")); }, 20_000);
  try {
    await client.request("initialize", { clientInfo: { name: "oar-structured-probe", version: "1" }, capabilities: { experimentalApi: true } });
    client.notify("initialized", {});
    const opened = await client.request("thread/start", { cwd: root, approvalPolicy: "never" });
    const threadId = asRecord(opened.thread)?.id;
    assert.equal(typeof threadId, "string");
    client.handle({ onNotification: (method, params) => { frames.push({ method, params }); if (method === "turn/completed") { end.resolve(); } }, onServerRequest: () => {} });
    await client.request("turn/start", { threadId, outputSchema: schema, input: [{ type: "text", text: "Report the answer", text_elements: [] }] });
    await end.promise;
    await writeFile(path.join(output, `codex-${mode}.jsonl`), `${frames.map((r) => JSON.stringify(r).replaceAll(root, "<TMP>")).join("\n")}\n`);
    console.log(JSON.stringify({ runtime: "codex", mode, calls: provider.raw.length,
      providerFormat: asRecord(provider.raw[0]?.body)?.text,
      frames: frames.filter((r) => ["item/completed", "turn/completed", "error"].includes(String(asRecord(r)?.method))) }).replaceAll(root, "<TMP>"));
  } finally { clearTimeout(timer); client.kill(); await client.exited; await provider.stop(); }
}

try {
  if (process.argv[2] === "claude") { for (const mode of ["valid", "invalid", "bad-schema"] as const) { await claude(mode); } }
  else { for (const mode of ["valid", "invalid", "bad-json", "schema-error"] as const) { await codex(mode); } }
} finally { await rm(root, { recursive: true, force: true }); }
