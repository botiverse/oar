import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { claudeInstallation, claudeSession, codexInstallation, codexSession, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock, startCodexAimock } from "../harness/aimock.js";

const outputSchema = { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false };

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("Claude validates native structured output on new and resumed sessions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oar-schema-"));
  const provider = await startClaudeAimock((mock) => { mock.onMessage(/[\s\S]*/u, { toolCalls: [{ name: "StructuredOutput", arguments: '{"answer":4}' }] }); });
  let session: Session | undefined = undefined;
  try {
    const installation = await claudeInstallation();
    if (installation.kind !== "available") { throw new Error("Claude unavailable"); }
    const env = { ...provider.env, CLAUDE_CONFIG_DIR: path.join(root, "config"), ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null };
    session = await claudeSession(installation, { cwd: root, env, outputSchema });
    expect(await promptAndWait(session, "Use StructuredOutput to give the answer", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed", structuredOutput: { answer: 4 } } });
    const id = session.id;
    await session.dispose();
    session = await claudeSession(installation, { cwd: root, env, outputSchema, resume: id });
    expect(await promptAndWait(session, "Give the answer again", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed", structuredOutput: { answer: 4 } } });
  } finally { await session?.dispose(); await provider.stop(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
}, 120_000);

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("Claude's exhausted schema retries fail without a structured value", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oar-schema-fail-"));
  const provider = await startClaudeAimock((mock) => { mock.onMessage(/[\s\S]*/u, { toolCalls: [{ name: "StructuredOutput", arguments: '{"answer":"wrong"}' }] }); });
  let session: Session | undefined = undefined;
  try {
    const installation = await claudeInstallation();
    if (installation.kind !== "available") { throw new Error("Claude unavailable"); }
    session = await claudeSession(installation, { cwd: root, outputSchema, env: { ...provider.env, CLAUDE_CONFIG_DIR: path.join(root, "config"), ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null } });
    const run = await promptAndWait(session, "Use StructuredOutput", { timeoutMs: 30_000 });
    expect(run).toMatchObject({ kind: "ended", outcome: { kind: "failed", failure: "unknown", reason: "error_max_structured_output_retries" } });
    if (run.kind !== "rejected") { expect(run.outcome).not.toHaveProperty("structuredOutput"); }
    const frame = session.records().find((record) => record.kind === "frame" && asRecord(record.body.native)?.type === "result");
    expect(frame?.kind === "frame" ? frame.body.native : null).toMatchObject({ terminal_reason: "structured_output_retry_exhausted" });
  } finally { await session?.dispose(); await provider.stop(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
}, 120_000);

test.skipIf(process.env.OAR_TEST !== "codex-aimock").each(['{"answer":4}', '{"answer":"wrong"}', "not JSON"])("Codex delegates schema to provider and returns only text: %s", async (text) => {
  const root = await mkdtemp(path.join(tmpdir(), "oar-schema-codex-"));
  const provider = await startCodexAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: text }); }, { captureRaw: true });
  let session: Session | undefined = undefined;
  try {
    const installation = await codexInstallation();
    if (installation.kind !== "available") { throw new Error("Codex unavailable"); }
    session = await codexSession(installation, { cwd: root, env: provider.env ?? {}, outputSchema });
    const run = await promptAndWait(session, "Give the answer", { timeoutMs: 30_000 });
    expect(run).toMatchObject({ kind: "ended", text, outcome: { kind: "completed" } });
    if (run.kind !== "rejected") { expect(run.outcome).not.toHaveProperty("structuredOutput"); }
    expect(asRecord(provider.raw.at(-1)?.body)?.text).toMatchObject({ format: { type: "json_schema", schema: outputSchema } });
    expect(await session.queue("again")).toMatchObject({ kind: "rejected", code: "unsupported" });
    const id = session.id;
    await session.dispose();
    session = await codexSession(installation, { cwd: root, env: provider.env ?? {}, outputSchema, resume: id });
    expect(await promptAndWait(session, "Again", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", text, outcome: { kind: "completed" } });
    expect(asRecord(provider.raw.at(-1)?.body)?.text).toMatchObject({ format: { schema: outputSchema } });
  } finally { await session?.dispose(); await provider.stop(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
}, 120_000);

test.skipIf(process.env.OAR_TEST !== "codex-aimock")("Codex reports a provider schema refusal as the native failed turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oar-schema-provider-"));
  const provider = await startCodexAimock((mock) => { mock.onMessage(/[\s\S]*/u, { error: { type: "invalid_request_error", message: "Invalid schema for response_format 'output'" }, status: 400 }); });
  let session: Session | undefined = undefined;
  try {
    const installation = await codexInstallation();
    if (installation.kind !== "available") { throw new Error("Codex unavailable"); }
    session = await codexSession(installation, { cwd: root, env: provider.env ?? {}, outputSchema });
    const run = await promptAndWait(session, "Give the answer", { timeoutMs: 30_000 });
    expect(run).toMatchObject({ kind: "ended", outcome: { kind: "failed", failure: "invalid_request" } });
    if (run.kind !== "rejected") { expect(run.outcome).not.toHaveProperty("structuredOutput"); }
    expect(JSON.stringify(session.records())).toContain("Invalid schema for response_format");
  } finally { await session?.dispose(); await provider.stop(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
}, 120_000);
