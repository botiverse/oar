import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { claudeInstallation, claudeSession, defineRuntime, piInstallation, piSession, type Session } from "../../packages/oar/src/index.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock, startPiAimock, type AimockEnv, type RawProviderRequest } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { echoesReceived, stdioEcho } from "./support/echo-mcp.js";

/** Actual native harnesses, with only the model replaced. Inspect the tools
 * offered to the provider, not the model's description of its abilities. */
function toolsIn(raw: readonly RawProviderRequest[]): string[] {
  return [...new Set(raw.flatMap((request) => {
    const tools = asRecord(request.body)?.tools;
    return Array.isArray(tools) ? tools.map((tool) => asRecord(tool)?.name).filter((name): name is string => typeof name === "string") : [];
  }))].toSorted();
}

async function offered(session: Session, env: AimockEnv): Promise<string[]> {
  const offset = env.raw.length;
  try {
    expect(await promptAndWait(session, "Reply with TOOL_FILTER_OK.", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    const tools = toolsIn(env.raw.slice(offset));
    expect(tools.length).toBeGreaterThan(0);
    return tools;
  } finally {
    await session.dispose();
  }
}

for (const name of ["claude", "pi"] as const) {
  describe.skipIf(process.env.OAR_TEST !== `${name}-aimock`)(`${name} disallowedTools`, () => {
    test("unknown native names open without error and leave the provider tool list unchanged", async () => {
      const start = name === "claude" ? startClaudeAimock : startPiAimock;
      const env = await start((mock) => { mock.onMessage(/TOOL_FILTER_OK/u, { content: "TOOL_FILTER_OK" }); }, { captureRaw: true });
      try {
        const runtime = name === "claude"
          ? defineRuntime({ id: "claude-aimock", installation: claudeInstallation, session: claudeSession })
          : defineRuntime({ id: "pi-aimock", installation: piInstallation, session: piSession });
        const subject = runtimeUnderTest(runtime, { ...env.env, ENABLE_TOOL_SEARCH: "false" });
        const baseline = await offered(await subject.startSession(), env);
        expect(await offered(await subject.startSession({ disallowedTools: ["NoSuchTool"] }), env)).toEqual(baseline);
        if (name === "claude") {
          expect(await offered(await subject.startSession({ disallowedTools: ["bash"] }), env)).toEqual(baseline);
        }
      } finally { await env.stop(); }
    }, 90_000);

    test("native builtin and MCP denial reaches new sessions and resumes; omitted and empty lists keep defaults", async () => {
      const start = name === "claude" ? startClaudeAimock : startPiAimock;
      const env = await start((mock) => { mock.onMessage(/TOOL_FILTER_OK/u, { content: "TOOL_FILTER_OK" }); }, { captureRaw: true });
      try {
        const runtime = name === "claude"
          ? defineRuntime({ id: "claude-aimock", installation: claudeInstallation, session: claudeSession })
          : defineRuntime({ id: "pi-aimock", installation: piInstallation, session: piSession });
        const subject = runtimeUnderTest(runtime, { ...env.env, ENABLE_TOOL_SEARCH: "false" });
        const builtin = name === "claude" ? "Bash" : "bash";
        const kept = name === "claude" ? "Read" : "read";
        const blockedMcp = "mcp__blocked__echo";
        const allowedMcp = "mcp__allowed__echo";
        const mcpServers = [stdioEcho("blocked"), stdioEcho("allowed")];
        const baseline = await subject.startSession({ mcpServers });
        expect(await offered(baseline, env)).toEqual(expect.arrayContaining([builtin, kept, blockedMcp, allowedMcp]));
        const disallowedTools = Object.freeze([builtin, blockedMcp]);
        const restricted = await subject.startSession({ mcpServers, disallowedTools });
        const filtered = await offered(restricted, env);
        expect(filtered).not.toContain(builtin);
        expect(filtered).not.toContain(blockedMcp);
        expect(filtered).toEqual(expect.arrayContaining([kept, allowedMcp]));
        const resumed = await subject.startSession({ resume: restricted.id, mcpServers, disallowedTools });
        const resumedTools = await offered(resumed, env);
        expect(resumed.id).toBe(restricted.id);
        expect(resumedTools).not.toContain(builtin);
        expect(resumedTools).not.toContain(blockedMcp);
        expect(resumedTools).toEqual(expect.arrayContaining([kept, allowedMcp]));
        const empty = await subject.startSession({ resume: restricted.id, mcpServers, disallowedTools: [] });
        expect(await offered(empty, env)).toEqual(expect.arrayContaining([builtin, blockedMcp, allowedMcp]));
      } finally {
        await env.stop();
      }
    }, 180_000);

    // The list selects what the model is offered; a model that calls a denied
    // tool anyway must not get it run. And a resume that omits the list has
    // no restriction: the deny channel is per process (claude) or per open (pi).
    test("a denied tool the model calls anyway is refused; a resume that omits the list restores it", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "oar-denied-"));
      const marker = path.join(dir, "ran");
      const builtin = name === "claude" ? "Bash" : "bash";
      const start = name === "claude" ? startClaudeAimock : startPiAimock;
      const env = await start((mock) => {
        mock.onMessage(/TOOL_FILTER_OK/u, { content: "TOOL_FILTER_OK" });
        mock.on({ userMessage: /CALL_DENIED/u, hasToolResult: false }, { toolCalls: [
          { name: builtin, arguments: JSON.stringify({ command: `echo ran > ${marker}` }) },
          { name: "mcp__blocked__echo", arguments: JSON.stringify({ text: "denied-call" }) },
        ] });
        mock.on({ userMessage: /CALL_DENIED/u, hasToolResult: true }, { content: "done" });
      }, { captureRaw: true });
      try {
        const runtime = name === "claude"
          ? defineRuntime({ id: "claude-aimock", installation: claudeInstallation, session: claudeSession })
          : defineRuntime({ id: "pi-aimock", installation: piInstallation, session: piSession });
        const subject = runtimeUnderTest(runtime, { ...env.env, ENABLE_TOOL_SEARCH: "false" });
        const mcpServers = [stdioEcho("blocked")];
        const restricted = await subject.startSession({ mcpServers, disallowedTools: [builtin, "mcp__blocked__echo"] });
        expect(await promptAndWait(restricted, "CALL_DENIED", { timeoutMs: 60_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
        const results = restricted.records().flatMap((record) => (record.kind === "frame" ? record.body.events : []))
          .flatMap((event) => (event.kind === "tool_call_ended" ? [event.result] : []));
        expect(results).toEqual(["failed", "failed"]);
        expect(echoesReceived(env.raw)).toEqual([]);
        expect(existsSync(marker)).toBe(false);
        await restricted.dispose();
        const resumed = await offered(await subject.startSession({ resume: restricted.id, mcpServers }), env);
        expect(resumed).toEqual(expect.arrayContaining([builtin, "mcp__blocked__echo"]));
      } finally {
        await env.stop();
      }
    }, 180_000);
  });
}
