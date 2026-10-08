import { describe, expect, test } from "vitest";
import { claudeInstallation, claudeSession, defineRuntime, piInstallation, piSession, type Session } from "../../packages/oar/src/index.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock, startPiAimock, type AimockEnv, type RawProviderRequest } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { stdioEcho } from "./support/echo-mcp.js";

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
  });
}
