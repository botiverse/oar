/**
 * Cursor's real local SDK and backend, with a harmless host echo tool.
 * BURNS TOKENS, needs a Cursor login. Run on SDK upgrades:
 * pnpm tsx experiments/cursor-disallowed-tools.ts
 *
 * A baseline must execute both shell and our MCP callback. Restricted new
 * and resumed agents must execute neither; another tool (read) stays usable.
 * The SDK's native resolver groups shell/stdin and the MCP family; this does
 * not check subagents (the SDK gives them a separate toolset).
 * Each round also prints its session id and native run results, including
 * usage when available, so a quota report need not repeat model calls.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent, Cursor, FileCredentialStore } from "@cursor/sdk";
import { createCursorRuntime, type CursorSdk, type Session } from "../packages/oar/src/index.js";
import { promptAndWait } from "../packages/oar/src/observe/turns.js";

const cwd = await mkdtemp(path.join(tmpdir(), "oar-cursor-tool-deny-"));
const echoCalls: string[] = [];
const customTools = {
  oar_echo: {
    description: "Return the given text, for the OAR tool selection probe.",
    inputSchema: { type: "object" as const, properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      await Promise.resolve();
      const text = String(args.text);
      echoCalls.push(text);
      return text;
    },
  },
};
const wrapped: CursorSdk = {
  Cursor, FileCredentialStore,
  Agent: {
    listRuns: Agent.listRuns.bind(Agent),
    create: async (options) => { const agent = await Agent.create({ ...options, local: { ...options.local, customTools } }); return agent; },
    resume: async (id, options) => { const agent = await Agent.resume(id, { ...options, local: { ...options.local, customTools } }); return agent; },
  },
};
const runtime = createCursorRuntime({ sdk: async () => { await Promise.resolve(); return wrapped; } });
const installation = { kind: "available", via: "bundled" } as const;
const model = process.env.OAR_TEST_MODEL ?? "gpt-5.4-nano";
const probe = "Use the shell tool to run printf 'SHELL_PROBE_OK', then invoke the oar_echo MCP tool with text 'MCP_PROBE_OK'. Do not use another tool as a substitute. If either is unavailable, just say so. Finally use the read tool to read probe.txt. Do not delegate.";

async function round(session: Session, phase: string): Promise<string[]> {
  try {
    const result = await promptAndWait(session, probe, { timeoutMs: 90_000 });
    assert.equal(result.kind, "ended");
    assert.equal(result.outcome.kind, "completed", JSON.stringify(result));
    return session.records().flatMap((record) => record.kind === "frame" ? record.body.events.flatMap((event) => event.kind === "tool_call_started" ? [event.tool] : []) : []);
  } finally {
    await session.dispose();
    const runs = session.records().flatMap((record) => record.kind === "frame" && record.body.type === "cursor/run_result" ? [record.body.native] : []);
    console.log(JSON.stringify({ phase, sessionId: session.id, runs }));
  }
}

try {
  await writeFile(path.join(cwd, "probe.txt"), "READ_PROBE_OK\n");
  const baseline = await runtime.session(installation, { cwd, model });
  const baselineTools = await round(baseline, "baseline");
  console.log(JSON.stringify({ phase: "baseline", tools: baselineTools, echoCalls: echoCalls.length }));
  assert.ok(baselineTools.includes("shell"));
  assert.ok(echoCalls.length > 0, "baseline must call the real SDK custom MCP tool");
  const count = echoCalls.length;
  const disallowedTools = ["shell", "mcp", "task"];
  const restricted = await runtime.session(installation, { cwd, model, disallowedTools });
  const blocked = await round(restricted, "restricted");
  console.log(JSON.stringify({ phase: "restricted", tools: blocked, echoCalls: echoCalls.length }));
  assert.ok(!blocked.includes("shell") && !blocked.includes("writeShellStdin") && !blocked.includes("mcp"));
  assert.ok(blocked.includes("read"), "unrelated native tools remain usable");
  assert.equal(echoCalls.length, count);
  const resumed = await runtime.session(installation, { cwd, model, resume: restricted.id, disallowedTools });
  const resumedTools = await round(resumed, "resume");
  console.log(JSON.stringify({ phase: "resume", tools: resumedTools, echoCalls: echoCalls.length }));
  assert.ok(!resumedTools.includes("shell") && !resumedTools.includes("writeShellStdin") && !resumedTools.includes("mcp"));
  assert.ok(resumedTools.includes("read"));
  assert.equal(echoCalls.length, count);
  console.log("PASS native Cursor shell/MCP denial on new and resumed sessions; read still executes");
} finally {
  await rm(cwd, { recursive: true, force: true });
}
