import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  grokRuntime,
  promptAndWait,
  toolResultText,
  type Event,
  type Frame,
  type RuntimeEventBody,
  type Session,
} from "../../packages/oar/src/index.js";
import type { AcpSessionProfile } from "../../packages/oar/src/shared/acp/profile.js";
import { grokRawToolOutput } from "../../packages/oar/src/runtimes/grok/session.js";
import { createAcpProjectionState, projectAcpUpdate, type AcpRawToolOutputReader } from "../../packages/oar/src/shared/acp/projection.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

const SECRET = "grok-fixture-secret-token-value";
let fixtureScriptPath = "";

vi.mock("../../packages/oar/src/runtimes/grok/session.js", async importOriginal => {
  const actual = await importOriginal<{ readonly grokAcpProfile: AcpSessionProfile; readonly grokRawToolOutput: typeof grokRawToolOutput }>();
  const { acpSession } = await import("../../packages/oar/src/shared/acp/session.js");
  const profile = { ...actual.grokAcpProfile, args: () => [fixtureScriptPath] };
  return { ...actual, grokAcpProfile: profile, grokSession: acpSession(profile) };
});

const FIXTURE_SERVER = String.raw`
import { createInterface } from "node:readline";
const secret = ${JSON.stringify(SECRET)};
const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update } });
const CASES = {
  ok: { toolCallId: "echo-ok", status: "completed", rawOutput: { type: "MCP", server_name: "echo", tool_name: "echo", output: { OkayOutput: "fixture result" } } },
  err: { toolCallId: "echo-err", status: "failed", rawOutput: { type: "MCP", server_name: "echo", tool_name: "echo", output: { Error: "fixture failure" }, is_error: true } },
  "with-content": {
    toolCallId: "echo-std", status: "failed",
    content: [{ type: "content", content: { type: "text", text: "explicit content wins" } }],
    rawOutput: { type: "MCP", server_name: "echo", tool_name: "echo", output: { Error: "fallback suppressed" }, is_error: true },
  },
  "empty-ok": { toolCallId: "echo-empty", status: "completed", rawOutput: { type: "MCP", server_name: "echo", tool_name: "echo", output: { OkayOutput: "" } } },
  "bad-shape": { toolCallId: "echo-invalid", status: "completed", rawOutput: { type: "MCP", server_name: "echo", tool_name: "echo", output: { Error: "mismatched status" } } },
  long: { toolCallId: "echo-long", status: "completed", rawOutput: { type: "MCP", server_name: "echo", tool_name: "echo", output: { OkayOutput: "Z".repeat(10_050) } } },
  "secret-ok": { toolCallId: "echo-secret-ok", status: "completed", rawOutput: { type: "MCP", server_name: "echo", tool_name: "echo", output: { OkayOutput: "ok with " + secret } } },
  "secret-err": { toolCallId: "echo-secret-err", status: "failed", rawOutput: { type: "MCP", server_name: "echo", tool_name: "echo", output: { Error: "err with " + secret }, is_error: true } },
};
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  if (req.method === "initialize") {
    respond(req.id, { protocolVersion: req.params?.protocolVersion ?? 1, agentCapabilities: {}, agentInfo: { name: "grok", version: "grok 1.0.77 (fixture)" } });
  } else if (req.method === "session/new") {
    respond(req.id, { sessionId: "fixture-session" });
  } else if (req.method === "session/prompt") {
    const spec = CASES[req.params?.prompt?.[0]?.text ?? ""];
    if (spec) {
      notify({ sessionUpdate: "tool_call", toolCallId: spec.toolCallId, title: "use_tool", rawInput: { tool_name: "echo__echo", tool_input: {} } });
      notify({ sessionUpdate: "tool_call_update", ...spec });
    }
    respond(req.id, { stopReason: "end_turn" });
  } else {
    respond(req.id, {});
  }
});
`;

const sessions: Session[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async session => { await session.dispose(); }));
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }); }));
});

function projectSingleEnd(callId: string, update: Record<string, unknown>, reader: AcpRawToolOutputReader | null = grokRawToolOutput): Extract<RuntimeEventBody, { kind: "tool_call_ended" }> {
  const state = createAcpProjectionState();
  projectAcpUpdate(state, { sessionUpdate: "tool_call", toolCallId: callId, title: "use_tool", status: "in_progress" }, reader ?? undefined);
  const events = projectAcpUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: callId, ...update }, reader ?? undefined);
  expect(events).toHaveLength(1);
  const [ended] = events;
  if (ended?.kind !== "tool_call_ended") { throw new Error(`expected tool_call_ended for ${callId}`); }
  return ended;
}

test("grokRawToolOutput projects non-empty OkayOutput/Error strings and scopes ACP fallback to Grok", () => {
  const mcpOk = { type: "MCP", server_name: "echo", tool_name: "echo", output: { OkayOutput: "fixture result" } };
  const mcpErr = { type: "MCP", server_name: "echo", tool_name: "echo", output: { Error: "fixture failure" }, is_error: true };
  expect(grokRawToolOutput(mcpOk, "completed")).toEqual([{ type: "text", text: "fixture result" }]);
  expect(grokRawToolOutput(mcpErr, "failed")).toEqual([{ type: "text", text: "fixture failure" }]);

  const okEnd = projectSingleEnd("mcp-ok", { status: "completed", rawOutput: mcpOk });
  expect(okEnd).toEqual({ kind: "tool_call_ended", callId: "mcp-ok", content: [{ type: "text", text: "fixture result" }], result: "ok" });
  expect(toolResultText(okEnd.content)).toBe("fixture result");

  const stdEnd = projectSingleEnd("mcp-std", { status: "failed", content: [{ type: "content", content: { type: "text", text: "rpc failure" } }], rawOutput: mcpErr });
  expect(stdEnd).toEqual({ kind: "tool_call_ended", callId: "mcp-std", content: [{ type: "text", text: "rpc failure" }], result: "failed" });
  expect(projectSingleEnd("mcp-generic", { status: "completed", rawOutput: mcpOk }, null).content).toEqual([{ type: "other", value: mcpOk }]);
});

test.each([
  ["empty-ok", { status: "completed", rawOutput: { type: "MCP", output: { OkayOutput: "" } } }, "ok"],
  ["empty-err", { status: "failed", rawOutput: { type: "MCP", output: { Error: "" } } }, "failed"],
  ["completed-with-error", { status: "completed", rawOutput: { type: "MCP", output: { Error: "wrong status" } } }, "ok"],
  ["failed-with-ok", { status: "failed", rawOutput: { type: "MCP", output: { OkayOutput: "wrong status" } } }, "failed"],
  ["cancelled-with-ok", { status: "cancelled", rawOutput: { type: "MCP", output: { OkayOutput: "cancelled" } } }, undefined],
  ["ambiguous", { status: "completed", rawOutput: { type: "MCP", output: { OkayOutput: "ok", Error: "err" } } }, "ok"],
  ["non-string", { status: "completed", rawOutput: { type: "MCP", output: { OkayOutput: 42 } } }, "ok"],
  ["non-object-output", { status: "completed", rawOutput: { type: "MCP", output: "plain" } }, "ok"],
  ["non-mcp", { status: "completed", rawOutput: { type: "ReadFile", output: { OkayOutput: "ignored" } } }, "ok"],
])("non-projected MCP shapes fall back to other without altering status: %s", (id, update, expectedResult) => {
  const ended = projectSingleEnd(`mcp-${id}`, update);
  expect(ended.result).toBe(expectedResult);
  expect(ended.content).toEqual([{ type: "other", value: update.rawOutput }]);
  expect(toolResultText(ended.content)).toBeUndefined();
});

test("non-terminal in_progress update does not promote MCP rawOutput", () => {
  const state = createAcpProjectionState();
  projectAcpUpdate(state, { sessionUpdate: "tool_call", toolCallId: "mcp-prog", title: "use_tool", status: "in_progress" }, grokRawToolOutput);
  const events = projectAcpUpdate(
    state,
    { sessionUpdate: "tool_call_update", toolCallId: "mcp-prog", status: "in_progress", rawOutput: { type: "MCP", output: { OkayOutput: "partial" } } },
    grokRawToolOutput,
  );
  expect(events.every((event) => event.kind !== "tool_call_ended")).toBe(true);
});

test("grok MCP projection cuts projected text at 10,000 characters", () => {
  const ended = projectSingleEnd("mcp-long", { status: "completed", rawOutput: { type: "MCP", output: { OkayOutput: "x".repeat(10_050) } } });
  expect(ended).toEqual({ kind: "tool_call_ended", callId: "mcp-long", content: [{ type: "text", text: `${"x".repeat(10_000)}…` }], result: "ok" });
});

async function openFixtureSession(): Promise<{ readonly session: Session; readonly observed: Event[] }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "oar-grok-mcp-output-"));
  roots.push(root);
  fixtureScriptPath = path.join(root, "fake-grok.mjs");
  await writeFile(fixtureScriptPath, FIXTURE_SERVER);
  const session = await grokRuntime.session(
    { kind: "available", via: "executable", command: process.execPath, version: "grok 1.0.77 (fixture)" },
    { cwd: root, env: { FIXTURE_API_KEY: SECRET } },
  );
  sessions.push(session);
  const observed: Event[] = [];
  session.events((event) => { observed.push(event); }, { cursor: { sessionId: session.id, afterSeq: -1 } });
  return { session, observed };
}

async function runToolPrompt(session: Session, name: string, callId: string): Promise<{ readonly ended: Extract<RuntimeEventBody, { kind: "tool_call_ended" }>; readonly frame: Frame }> {
  const before = session.records().length;
  const outcome = await promptAndWait(session, name, { timeoutMs: 10_000 });
  expect(outcome).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
  const frames = session.records().slice(before).filter((record): record is Frame => record.kind === "frame");
  const frame = frames.find((item) => item.body.events.some((event) => event.kind === "tool_call_ended" && event.callId === callId));
  const ended = frame?.body.events.find((event) => event.kind === "tool_call_ended" && event.callId === callId);
  if (frame === undefined || ended?.kind !== "tool_call_ended") { throw new Error(`missing tool_call_ended frame for ${callId}`); }
  return { ended, frame };
}

test("grokRuntime projects MCP rawOutput OkayOutput/Error and retains standard ACP content", async () => {
  const { session, observed } = await openFixtureSession();
  const ok = await runToolPrompt(session, "ok", "echo-ok");
  expect(ok.ended).toEqual({ kind: "tool_call_ended", callId: "echo-ok", content: [{ type: "text", text: "fixture result" }], result: "ok" });
  expect(observed).toContainEqual(expect.objectContaining(ok.ended));

  const err = await runToolPrompt(session, "err", "echo-err");
  expect(err.ended).toEqual({ kind: "tool_call_ended", callId: "echo-err", content: [{ type: "text", text: "fixture failure" }], result: "failed" });
  expect(observed).toContainEqual(expect.objectContaining(err.ended));

  const std = await runToolPrompt(session, "with-content", "echo-std");
  expect(std.ended).toEqual({ kind: "tool_call_ended", callId: "echo-std", content: [{ type: "text", text: "explicit content wins" }], result: "failed" });
});

test("grokRuntime keeps empty/invalid fallback and truncates long text while keeping native whole", async () => {
  const { session } = await openFixtureSession();
  const empty = await runToolPrompt(session, "empty-ok", "echo-empty");
  expect(toolResultText(empty.ended.content)).toBeUndefined();
  const bad = await runToolPrompt(session, "bad-shape", "echo-invalid");
  expect(toolResultText(bad.ended.content)).toBeUndefined();

  const long = await runToolPrompt(session, "long", "echo-long");
  expect(long.ended.content).toEqual([{ type: "text", text: `${"Z".repeat(10_000)}…` }]);
  const rawOutput = asRecord(asRecord(asRecord(long.frame.body.native)?.update)?.rawOutput);
  expect(asRecord(rawOutput?.output)?.OkayOutput).toBe("Z".repeat(10_050));
});

test("grokRuntime redacts credentials from projected MCP text parts and native frames", async () => {
  const { session, observed } = await openFixtureSession();
  const secretOk = await runToolPrompt(session, "secret-ok", "echo-secret-ok");
  expect(secretOk.ended.content).toEqual([{ type: "text", text: "ok with [redacted]" }]);
  const secretErr = await runToolPrompt(session, "secret-err", "echo-secret-err");
  expect(secretErr.ended.content).toEqual([{ type: "text", text: "err with [redacted]" }]);
  expect(JSON.stringify([session.records(), observed])).not.toContain(SECRET);
});
