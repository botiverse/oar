import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { codexRuntime, type Session } from "../../packages/oar/src/index.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { namespaceMcpToolCalls, startCodexAimock, type AimockEnv } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { ECHO_SERVER, echoesReceived, stdioEcho } from "./support/echo-mcp.js";

async function offered(session: Session, env: AimockEnv): Promise<string[]> {
  const offset = env.raw.length;
  try {
    expect(await promptAndWait(session, "Reply TOOL_FILTER_OK.", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    return [...new Set(env.raw.slice(offset).flatMap((request) => {
      const tools = asRecord(request.body)?.tools;
      return (Array.isArray(tools) ? tools : []).map((tool) => asRecord(tool)?.name).filter((name): name is string => typeof name === "string");
    }))].toSorted();
  } finally {
    await session.dispose();
  }
}

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex disallowedTools", () => {
  test("session MCP deny works on create/resume, preserves existing user denies and leaves config unchanged", async () => {
    const env = await startCodexAimock((mock) => { mock.onMessage(/TOOL_FILTER_OK/u, { content: "TOOL_FILTER_OK" }); }, { captureRaw: true });
    try {
      const config = path.join(env.env?.CODEX_HOME ?? "", "config.toml");
      await appendFile(config, `\n[mcp_servers.prior]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(ECHO_SERVER)}]\ndisabled_tools = ["echo"]\n`);
      const subject = runtimeUnderTest(codexRuntime, env.env);
      const mcpServers = [stdioEcho("blocked"), stdioEcho("allowed")];
      const baseline = await offered(await subject.startSession({ mcpServers }), env);
      expect(baseline).toEqual(expect.arrayContaining(["mcp__blocked", "mcp__allowed"]));
      expect(baseline).not.toContain("mcp__prior");
      // A first native thread may persist its workspace trust. Snapshot after that baseline.
      const original = await readFile(config, "utf8");
      const disallowedTools = ["mcp__blocked__echo", "mcp__prior__another_tool"];
      const restricted = await subject.startSession({ mcpServers, disallowedTools });
      const tools = await offered(restricted, env);
      expect(tools).not.toContain("mcp__blocked");
      expect(tools).not.toContain("mcp__prior");
      expect(tools).toContain("mcp__allowed");
      const resumed = await offered(await subject.startSession({ resume: restricted.id, mcpServers, disallowedTools }), env);
      expect(resumed).not.toContain("mcp__blocked");
      expect(resumed).not.toContain("mcp__prior");
      expect(resumed).toContain("mcp__allowed");
      const cleared = await offered(await subject.startSession({ resume: restricted.id, mcpServers, disallowedTools: [] }), env);
      expect(cleared).toEqual(expect.arrayContaining(["mcp__blocked", "mcp__allowed"]));
      expect(cleared).not.toContain("mcp__prior");
      expect(await readFile(config, "utf8")).toBe(original);
    } finally {
      await env.stop();
    }
  }, 180_000);

  // A model that calls the denied namespace anyway gets codex's refusal, not
  // the tool; a resume that omits the list has no restriction.
  test("a denied MCP tool the model calls anyway is refused; a resume that omits the list restores it", async () => {
    const env = await startCodexAimock((mock) => {
      mock.onMessage(/TOOL_FILTER_OK/u, { content: "TOOL_FILTER_OK" });
      mock.on({ userMessage: /CALL_DENIED/u, hasToolResult: false }, { toolCalls: [
        { name: "mcp__blocked__echo", arguments: JSON.stringify({ text: "denied-call" }) },
        { name: "mcp__allowed__echo", arguments: JSON.stringify({ text: "allowed-call" }) },
      ] });
      mock.on({ userMessage: /CALL_DENIED/u, hasToolResult: true }, { content: "done" });
    }, { captureRaw: true, rewriteResponse: namespaceMcpToolCalls });
    try {
      const subject = runtimeUnderTest(codexRuntime, env.env);
      const mcpServers = [stdioEcho("blocked"), stdioEcho("allowed")];
      const restricted = await subject.startSession({ mcpServers, disallowedTools: ["mcp__blocked__echo"] });
      expect(await promptAndWait(restricted, "CALL_DENIED", { timeoutMs: 90_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      expect(echoesReceived(env.raw)).toEqual(["echo:allowed-call via=stdio token=none"]);
      expect(JSON.stringify(env.raw.at(-1)?.body)).toContain("unsupported call: mcp__blocked");
      await restricted.dispose();
      expect(await offered(await subject.startSession({ resume: restricted.id, mcpServers }), env)).toEqual(expect.arrayContaining(["mcp__blocked", "mcp__allowed"]));
    } finally {
      await env.stop();
    }
  }, 180_000);
});
