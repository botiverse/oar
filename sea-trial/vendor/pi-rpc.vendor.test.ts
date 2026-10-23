/* oxlint-disable import/max-dependencies -- Native process evidence and the shared provider fixture. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, realpath, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { createPiRuntime, promptAndWait, type Session, type SessionOptions } from "../../packages/oar/src/index.js";
import { piSessionDir } from "../../packages/oar/src/runtimes/pi/resolve.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startPiAimock } from "../harness/aimock.js";
import { stdioEcho } from "./support/echo-mcp.js";
import { piChildCwd } from "./support/pi-runtime.js";
import { eventually, gone } from "../../tests/fixtures/process-tree.js";

const runtime = createPiRuntime({ execution: "subprocess" });
const builtins = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const register = `pi.registerTool({ name: "history_probe", description: "probe", label: "probe", defaultActive: false,
  parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "PROBE_EXECUTED" }] }) });`;

async function fixture(extension: string, emptyDefaults = false) {
  const env = await startPiAimock((mock) => {
    mock.on({ userMessage: /CALL_PROBE/u, hasToolResult: false }, { toolCalls: [{ name: "history_probe", arguments: "{}" }] });
    mock.on({ userMessage: /CALL_PROBE/u, hasToolResult: true }, { content: "done" });
    mock.onMessage(/^(?!CALL_PROBE)[\s\S]*$/u, { content: "ok" });
  }, { captureRaw: true, reasoningModel: true, settings: emptyDefaults ? { defaultTools: [] } : {} });
  const agentDir = process.env.OAR_PI_AGENT_DIR;
  assert.ok(agentDir !== undefined);
  const cwd = path.join(agentDir, "project");
  await mkdir(cwd);
  await mkdir(path.join(agentDir, "extensions"));
  await writeFile(path.join(agentDir, "extensions", "probe.ts"), `export default async (pi) => { ${extension} };`);
  const sessions: Session[] = [];
  const installation = await runtime.installation();
  assert.ok(installation.kind === "available");
  return { env, agentDir, cwd,
    async open(options: Partial<SessionOptions> = {}) {
      const session = await runtime.session(installation, { cwd, ...(options.resume === undefined ? { model: "aimock/aimock-thinking" } : {}), ...options, env: { ...env.env, ...options.env } });
      sessions.push(session);
      return session;
    },
    async stop() {
      try { await Promise.all(sessions.map(async (session) => session.dispose())); }
      finally { await env.stop(); }
    },
  };
}
async function turn(session: Session, input = "hello") {
  expect(await promptAndWait(session, input, { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
}
function toolNames(request: unknown): string[] {
  assert.ok(asRecord(request) !== null);
  const tools = asRecord(request)?.tools;
  if (tools === undefined) { return []; }
  assert.ok(Array.isArray(tools));
  return tools.flatMap((tool) => typeof asRecord(tool)?.name === "string" ? [String(asRecord(tool)?.name)] : []);
}

describe.skipIf(process.env.OAR_TEST !== "pi-rpc-aimock")("bundled Pi RPC process boundaries", () => {
  test("a symbolic cwd keeps native session identity and resumes through RPC and SDK", async () => {
    const f = await fixture("");
    const cwd = path.join(f.agentDir, "project-link");
    await symlink(f.cwd, cwd, process.platform === "win32" ? "junction" : "dir");
    try {
      const fresh = await f.open({ cwd, name: "linked project" });
      await turn(fresh, "linked_history_marker");
      await fresh.dispose();
      const directory = piSessionDir(cwd, f.agentDir);
      const files = await readdir(directory);
      const file = files.find((name) => name.endsWith(".jsonl"));
      assert.ok(file !== undefined);
      const text = readFileSync(path.join(directory, file), "utf8");
      const header = asRecord(JSON.parse(text.split("\n")[0] ?? "null"));
      expect(header?.cwd).toBe(piChildCwd(cwd));
      expect(await realpath(String(header?.cwd))).toBe(await realpath(cwd));
      const resumed = await f.open({ cwd, resume: fresh.id });
      await turn(resumed, "after_rpc_resume");
      expect(resumed.id).toBe(fresh.id);
      expect(JSON.stringify(f.env.raw.at(-1)?.body)).toContain("linked_history_marker");
      await resumed.dispose();
      const sdk = createPiRuntime();
      const installation = await sdk.installation();
      assert.ok(installation.kind === "available");
      const embedded = await sdk.session(installation, { cwd, resume: fresh.id });
      try { expect(embedded.id).toBe(fresh.id); await turn(embedded, "after_sdk_resume"); }
      finally { await embedded.dispose(); }
    } finally { await f.stop(); }
  }, 90_000);

  test.each([false, true])("a host-selected Pi executable reports context from each settled turn; prefix args=%s", async (prefix) => {
    const f = await fixture("");
    const selected = createPiRuntime({ execution: "subprocess", ...(prefix
      ? { command: process.execPath, args: [fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"))] }
      : { command: path.resolve(`node_modules/.bin/pi${process.platform === "win32" ? ".cmd" : ""}`) }) });
    const installation = await selected.installation();
    assert.ok(installation.kind === "available");
    const session = await selected.session(installation, { cwd: f.cwd, model: "aimock/aimock-thinking", env: { ...f.env.env } });
    try {
      await turn(session, "first");
      await turn(session, "second");
      const records = session.records();
      const usage = records.flatMap((row) => row.kind === "frame" ? row.body.events.flatMap((event) => event.kind === "usage" && event.usage.context !== undefined ? [event.usage.context] : []) : []);
      const stats = records.flatMap((row) => {
        if (row.kind !== "frame") { return []; }
        const native = asRecord(row.body.native);
        return native?.command === "get_session_stats" && native.success === true ? [asRecord(native.data)?.contextUsage] : [];
      });
      expect(stats).toHaveLength(2);
      expect(usage).toEqual(stats);
      expect(session.contextUsage().value).toEqual(stats.at(-1));
    } finally { await session.dispose(); await f.stop(); }
  }, 60_000);

  test("a new process restores id, model and transcript, including activated defaults; current exclusions still win", async () => {
    const f = await fixture(`${register}\npi.on("session_start", () => {
      if (process.env.OAR_PROBE_ACTIVATE === "1") pi.setActiveTools([...pi.getActiveTools(), "history_probe"]);
    });`);
    try {
      const fresh = await f.open();
      await turn(fresh);
      expect(toolNames(f.env.raw.at(-1)?.body)).not.toContain("history_probe");
      await fresh.dispose();
      const saved = await f.open({ effort: "high", env: { OAR_PROBE_ACTIVATE: "1" } });
      await turn(saved, "historical_rpc_marker");
      expect(toolNames(f.env.raw.at(-1)?.body)).toContain("history_probe");
      await saved.dispose();
      const resumed = await f.open({ resume: saved.id });
      expect(resumed.id).toBe(saved.id);
      expect(resumed.model().value).toBe("aimock/aimock-thinking");
      expect(resumed.effort().value).toBe("high");
      await turn(resumed, "CALL_PROBE");
      expect(JSON.stringify(f.env.raw.at(-1)?.body)).toContain("historical_rpc_marker");
      expect(JSON.stringify(f.env.raw.at(-1)?.body)).toContain("PROBE_EXECUTED");
      await resumed.dispose();
      const denied = await f.open({ resume: saved.id, disallowedTools: ["history_probe"] });
      const offset = f.env.raw.length;
      await turn(denied, "CALL_PROBE");
      expect(toolNames(f.env.raw[offset]?.body)).not.toContain("history_probe");
      const ends = denied.records().flatMap((row) => row.kind === "frame" ? row.body.events.filter((event) => event.kind === "tool_call_ended") : []);
      expect(ends).toEqual([expect.objectContaining({ result: "failed" })]);
    } finally { await f.stop(); }
  }, 120_000);

  test("native RPC keeps pending restored names when no tool can initially be activated; late registration can activate them", async () => {
    const f = await fixture(`pi.on("session_start", () => { ${register} });`, true);
    try {
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      const saved = SessionManager.create(f.cwd, piSessionDir(f.cwd, f.agentDir));
      saved.appendMessage({ role: "user", content: "previous turn", timestamp: Date.now() });
      saved.appendMessage({ role: "system", content: "", timestamp: Date.now(), toolsAdded: [{ name: "history_probe", description: "probe", parameters: { type: "object", properties: {} } }] });
      const fresh = await f.open({ disallowedTools: builtins });
      await turn(fresh);
      expect(toolNames(f.env.raw.at(-1)?.body)).not.toContain("history_probe");
      await fresh.dispose();
      const resumed = await f.open({ resume: saved.getSessionId(), disallowedTools: builtins });
      await turn(resumed, "CALL_PROBE");
      expect(toolNames(f.env.raw.at(-1)?.body)).toContain("history_probe");
      expect(JSON.stringify(f.env.raw.at(-1)?.body)).toContain("PROBE_EXECUTED");
    } finally { await f.stop(); }
  }, 90_000);

  test.each([false, true])("current builtin defaults replace historical exclusions before user session_start; override=%s", async (override) => {
    const f = await fixture(override ? 'pi.on("session_start", () => { pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "grep")); });' : "");
    try {
      const original = await f.open({ disallowedTools: ["read", "bash"] });
      await turn(original);
      await original.dispose();
      await writeFile(path.join(f.agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "grep"] }));
      const fresh = await f.open();
      await turn(fresh);
      const expected = override ? ["read"] : ["grep", "read"];
      expect(toolNames(f.env.raw.at(-1)?.body).toSorted()).toEqual(expected);
      await fresh.dispose();
      const resumed = await f.open({ resume: original.id });
      await turn(resumed);
      expect(toolNames(f.env.raw.at(-1)?.body).toSorted()).toEqual(expected);
    } finally { await f.stop(); }
  }, 90_000);

  test("handled input has no invented completion and does not leave the next prompt busy", async () => {
    const f = await fixture('pi.on("input", (event) => event.text === "HANDLED" ? { action: "handled" } : { action: "continue" });');
    try {
      const session = await f.open();
      expect(await session.prompt("HANDLED")).toMatchObject({ response: { body: { kind: "accepted" } } });
      expect(f.env.raw).toEqual([]);
      expect(session.records().flatMap((row) => row.kind === "frame" ? row.body.events.filter((event) => event.kind === "turn_ended") : [])).toEqual([]);
      await turn(session);
    } finally { await f.stop(); }
  }, 60_000);

  test("a native crash settles the pending prompt and reports its actual exit without an invented turn end", async () => {
    const f = await fixture('pi.on("input", () => { process.exit(23); });');
    try {
      const session = await f.open();
      expect(await session.prompt("crash")).toMatchObject({ response: { body: { kind: "rejected" } } });
      await session.dispose();
      expect(session.records()).toContainEqual(expect.objectContaining({ kind: "response", body: { kind: "exited", code: 23 } }));
      expect(session.records().flatMap((row) => row.kind === "frame" ? row.body.events.filter((event) => event.kind === "turn_ended") : [])).toEqual([]);
    } finally { await f.stop(); }
  }, 60_000);

  test.each([false, true])("dispose bounds native shutdown, removes owned descendants and private files; hanging hook=%s", async (hang) => {
    const f = await fixture(`
      const fs = await import("node:fs");
      const cp = await import("node:child_process");
      pi.on("session_start", (_event, ctx) => {
        const tool = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
        tool.unref();
        fs.writeFileSync(ctx.cwd + "/pids.json", JSON.stringify({ agent: process.pid, tool: tool.pid,
          privateDir: process.env.OAR_PI_RPC_DIRECTORY, argv: process.argv }));
      });
      pi.on("session_shutdown", async (_event, ctx) => {
        ${hang ? 'await new Promise(() => {});' : 'await new Promise((resolve) => setTimeout(resolve, 25));'}
        fs.writeFileSync(ctx.cwd + "/shutdown-completed", "done");
      });
    `);
    try {
      const session = await f.open({ mcpServers: [stdioEcho("private", "private-pi-rpc-key")] });
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- This test extension wrote the file immediately before get_state.
      const pids: { agent: number; tool: number; privateDir: string; argv: string[] } = JSON.parse(readFileSync(path.join(f.cwd, "pids.json"), "utf8"));
      expect(pids.argv.join(" ")).not.toContain("private-pi-rpc-key");
      const privateFiles = await readdir(pids.privateDir);
      expect(privateFiles.toSorted()).toEqual(["config.json", "extension.mjs", "ready"]);
      expect(readFileSync(path.join(pids.privateDir, "config.json"), "utf8")).toContain("private-pi-rpc-key");
      if (process.platform !== "win32") { expect(statSync(path.join(pids.privateDir, "config.json")).mode & 0o777).toBe(0o600); }
      vi.stubEnv("OAR_KILL_GRACE_MS", "500");
      const before = performance.now();
      await session.dispose();
      expect(performance.now() - before).toBeLessThan(15_000);
      expect(await gone(pids.agent)).toBe(true);
      expect(await gone(pids.tool)).toBe(true);
      expect(existsSync(pids.privateDir)).toBe(false);
      expect(existsSync(path.join(f.cwd, "shutdown-completed"))).toBe(!hang);
      expect(await eventually(() => session.records().some((row) => row.kind === "response" && row.body.kind === "exited"), 1000)).toBe(true);
    } finally { vi.unstubAllEnvs(); await f.stop(); }
  }, 60_000);
});
