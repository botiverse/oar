/* oxlint-disable import/max-dependencies -- Native controls, isolated model replay, and actual MCP server fixtures. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, onTestFailed, test } from "vitest";
import { promptAndWait } from "../../packages/oar/src/index.js";
import type { SessionOptions, Session } from "../../packages/oar/src/contracts/session.js";
import { qoderSession } from "../../packages/oar/src/runtimes/qoder/session.js";
import { qoderInstallation } from "../../packages/oar/src/runtimes/qoder/installation.js";
import { startQoderNative } from "../harness/qoder-native.js";
import { echoServers, startHttpEcho, leakedCredentials } from "./support/echo-mcp.js";

async function open(env: Awaited<ReturnType<typeof startQoderNative>>, options: Partial<SessionOptions> = {}) {
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
  test("startup idle, consecutive prompts and current-open usage survive resume", async () => {
    const env = await startQoderNative([{ text: "one", input: 100, output: 10 }, { text: "two", input: 200, output: 20 }]);
    try {
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
    } finally { await env.stop(); }
  }, 90_000);

  test("applied effort is read back while native private settings stay private", async () => {
    const env = await startQoderNative([{ text: "effort" }]);
    try {
      const session = await open(env, { effort: "high" });
      try {
        expect(session.effort().value).toBe("high");
        expect(JSON.stringify(session.records())).not.toContain('"useExternal"');
        const result = await turn(session);
        expect(result.outcome).toEqual({ kind: "completed" });
      } finally { await session.dispose(); }
    } finally { await env.stop(); }
  }, 45_000);

  test("MCP stdio and HTTP tools return real server results", async () => {
    const env = await startQoderNative([{ tool: { name: "mcp__echo__echo", args: { text: "stdio-call" } } },
      { tool: { name: "mcp__remote__echo", args: { text: "http-call" } } }, { text: "done" }]);
    const http = await startHttpEcho();
    try {
      const session = await open(env, { mcpServers: echoServers(http.url) });
      try {
        const result = await turn(session, "call echo");
        expect(result.outcome).toEqual({ kind: "completed" });
        const records = JSON.stringify(session.records());
        expect(records).toContain("echo:stdio-call via=stdio");
        expect(records).toContain("echo:http-call via=http");
        expect(leakedCredentials(session)).toEqual([]);
      } finally { await session.dispose(); }
    } finally { http.stop(); await env.stop(); }
  }, 60_000);

  test("missing resume fails without a replacement conversation", async () => {
    const env = await startQoderNative([{ text: "must not run" }]);
    try { await expect(open(env, { resume: randomUUID() })).rejects.toThrow(); }
    finally { await env.stop(); }
  }, 45_000);

  test("an excluded shell tool cannot execute a forced native call", async () => {
    const env = await startQoderNative([{ tool: { name: "Bash", args: { command: "echo unwanted > oar-denied-marker" } } }, { text: "done" }]);
    try {
      const session = await open(env, { disallowedTools: ["Bash"] });
      try {
        const result = await turn(session, "exercise the excluded tool");
        expect(result.outcome).toEqual({ kind: "completed" });
        expect(existsSync(path.join(env.options.cwd, "oar-denied-marker"))).toBe(false);
        const ends = session.records().flatMap((record) => record.kind === "frame" ? record.body.events.filter((event) => event.kind === "tool_call_ended") : []);
        expect(ends).toContainEqual(expect.objectContaining({ result: "failed" }));
      } finally { await session.dispose(); }
    } finally { await env.stop(); }
  }, 45_000);
});
