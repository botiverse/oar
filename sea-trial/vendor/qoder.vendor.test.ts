/* oxlint-disable import/max-dependencies -- Native controls, isolated model replay, and actual MCP server fixtures. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, onTestFailed, test } from "vitest";
import { promptAndWait } from "../../packages/oar/src/index.js";
import type { SessionOptions, Session } from "../../packages/oar/src/contracts/session.js";
import { qoderSession } from "../../packages/oar/src/runtimes/qoder/session.js";
import { QODER_MCP_PREFIX } from "../../packages/oar/src/runtimes/qoder/mcp-config.js";
import { qoderInstallation } from "../../packages/oar/src/runtimes/qoder/installation.js";
import { qoderFixture } from "./support/qoder-fixture.js";
import { echoServers, HTTP_AUTHORIZATION, startHttpEcho, STDIO_TOKEN, leakedCredentials } from "./support/echo-mcp.js";

function qoderMcpDirectories(): readonly string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(`${QODER_MCP_PREFIX}${String(process.pid)}-`));
}
async function qoderMcpConfigsGone(ms: number): Promise<readonly string[]> {
  const deadline = Date.now() + ms;
  while (qoderMcpDirectories().length > 0 && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling for FIFO cleanup after Qoder startup read.
    await delay(50);
  }
  return qoderMcpDirectories();
}
async function persistedCredentials(directory: string): Promise<string[]> {
  const leaked: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { leaked.push(...await persistedCredentials(full)); }
    else if (entry.isFile()) {
      const text = await readFile(full, "utf8").catch(() => "");
      if (text.includes(STDIO_TOKEN) || text.includes(HTTP_AUTHORIZATION)) { leaked.push(full); }
    }
  }
  return leaked;
}

async function open(env: Awaited<ReturnType<typeof qoderFixture>>, options: Partial<SessionOptions> = {}) {
  const installation = await qoderInstallation();
  assert.ok(installation.kind === "available");
  const session = await qoderSession(installation, { ...env.options, model: "efficient", ...options });
  onTestFailed(async () => { await mkdir("oar-trial-run/qoder-vendor", { recursive: true }); await writeFile(`oar-trial-run/qoder-vendor/${session.id}.json`, JSON.stringify(session.records(), null, 2)); });
  return session;
}
async function turn(session: Session, input = "hello") {
  const result = await promptAndWait(session, input, { timeoutMs: 30_000 });
  assert.ok(result.kind === "ended", JSON.stringify(result)); return result;
}

describe.skipIf(process.env.OAR_TEST !== "qoder-native")("Qoder native model replay", () => {
  test("an unknown task gets a native acknowledgement without inventing a task", async () => {
    const env = await qoderFixture([]);
    const session = await open(env);
    try {
      expect(await session.stopTask?.("missing-task")).toMatchObject({ kind: "accepted", response: { body: { native: { type: "control_response", response: { subtype: "success" } } } } });
      expect(session.records().flatMap(record => record.kind === "frame" ? record.body.events.filter(event => event.kind.startsWith("task_")) : [])).toEqual([]);
      expect(session.status().value.kind).toBe("idle");
    } finally { await session.dispose(); }
  }, 45_000);

  test("startup idle, consecutive prompts and current-open usage survive resume", async () => {
    const env = await qoderFixture([{ text: "one", input: 100, output: 10 }, { text: "two", input: 200, output: 20 }]);
    const session = await open(env);
    try {
      expect(session.status().value.kind).toBe("idle");
      const first = await turn(session, "history_marker");
      expect(first.text).toBe("one");
      const second = await turn(session, "second_marker");
      expect(second.text).toBe("two");
      expect(session.usage().value.total).toEqual({ input: 300, output: 30, cacheRead: 0, cacheWrite: 0 });
    } finally { await session.dispose(); }
    const resumed = await open(env, { resume: session.id });
    try {
      const result = await turn(resumed, "resume_marker");
      expect(result.outcome).toEqual({ kind: "completed" });
      expect(resumed.id).toBe(session.id);
      expect(resumed.usage().value.total).toEqual({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
    } finally { await resumed.dispose(); }
  }, 90_000);

  test("applied effort is read back while native private settings stay private", async () => {
    const env = await qoderFixture([{ text: "effort" }]);
    const session = await open(env, { model: "ultimate", effort: "high" });
    try {
      expect(session.effort().value).toBe("high");
      expect(JSON.stringify(session.records())).not.toContain('"useExternal"');
      const result = await turn(session);
      expect(result.outcome).toEqual({ kind: "completed" });
    } finally { await session.dispose(); }
  }, 45_000);

  test("MCP stdio and HTTP tools return real server results after the private config handoff is gone", async () => {
    const env = await qoderFixture([
      { tool: { name: "mcp__echo__echo", args: { text: "stdio-call" } } },
      { tool: { name: "mcp__remote__echo", args: { text: "http-call" } } },
      { tool: { name: "mcp__echo__echo", args: { text: "stdio-second" } } },
      { tool: { name: "mcp__remote__echo", args: { text: "http-second" } } },
      { text: "done" },
    ]);
    const http = await startHttpEcho();
    try {
      const session = await open(env, { mcpServers: echoServers(http.url) });
      try {
        expect(await qoderMcpConfigsGone(10_000)).toEqual([]);
        const result = await turn(session, "call echo");
        expect(result.outcome).toEqual({ kind: "completed" });
        const records = JSON.stringify(session.records());
        expect(records).toContain("echo:stdio-call via=stdio");
        expect(records).toContain("echo:http-call via=http");
        expect(records).toContain("echo:stdio-second via=stdio");
        expect(records).toContain("echo:http-second via=http");
        expect(leakedCredentials(session)).toEqual([]);
      } finally { await session.dispose(); }
      expect(await persistedCredentials(env.home)).toEqual([]);
    } finally { http.stop(); }
  }, 60_000);

  test("missing resume fails without a replacement conversation", async () => {
    const env = await qoderFixture([{ text: "must not run" }]);
    await expect(open(env, { resume: randomUUID() })).rejects.toThrow();
  }, 45_000);

  test("an excluded shell tool cannot execute a forced native call", async () => {
    const env = await qoderFixture([{ tool: { name: "Bash", args: { command: "echo unwanted > oar-denied-marker" } } }, { text: "done" }]);
    const session = await open(env, { disallowedTools: ["Bash"] });
    try {
      const result = await turn(session, "exercise the excluded tool");
      expect(result.outcome).toEqual({ kind: "completed" });
      expect(existsSync(path.join(env.options.cwd, "oar-denied-marker"))).toBe(false);
      const ends = session.records().flatMap((record) => record.kind === "frame" ? record.body.events.filter((event) => event.kind === "tool_call_ended") : []);
      expect(ends).toContainEqual(expect.objectContaining({ result: "failed" }));
    } finally { await session.dispose(); }
  }, 45_000);
});
