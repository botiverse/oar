/* oxlint-disable no-await-in-loop, max-statements -- Each independent native session retains its seed, resume and cleanup controls. */
import assert from "node:assert/strict";
import { expect, test } from "vitest";
import type { McpServer, Session } from "../../packages/oar/src/contracts/session.js";
import { kimiRuntime } from "../../packages/oar/src/runtimes/kimi/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { versionAtLeast } from "../../packages/oar/src/shared/update.js";
import { startKimiAimock } from "../harness/aimock-acp.js";
import type { RawProviderRequest } from "../harness/aimock.js";
import { echoFixtures, echoServers, fingerprint, startHttpEcho, stdioEcho } from "./support/echo-mcp.js";
import { structuralToolRound } from "./support/tool-round.js";

function declarations(request: RawProviderRequest | undefined): readonly string[] {
  const tools = asRecord(request?.body)?.tools;
  assert.ok(Array.isArray(tools), "The resumed turn must reach the provider with a tool catalog");
  return tools.map(tool => String(asRecord(asRecord(tool)?.function)?.name)).filter(name => name.startsWith("mcp__")).toSorted();
}
function results(requests: readonly RawProviderRequest[], id: string): readonly unknown[] {
  const values = requests.flatMap(request => {
    const messages = asRecord(request.body)?.messages;
    return Array.isArray(messages) ? messages.map(message => asRecord(message)).filter(message => message?.role === "tool" && message.tool_call_id === id).map(message => message?.content) : [];
  });
  return [...new Set(values)];
}
const names = ["mcp__echo__echo", "mcp__remote__echo"];
const replacementStdio = "oar-replacement-stdio";
const replacementHttp = "Bearer oar-replacement-http";

test.skipIf(process.env.OAR_TEST !== "kimi-aimock").each(["omitted", "empty", "replacement"] as const)("Kimi %s MCP resume matches versioned declarations and actual execution", { timeout: 180_000 }, async mode => {
  const installation = await kimiRuntime.installation();
  assert.equal(installation.kind, "available"); assert.equal(installation.via, "executable");
  assert.ok(installation.version !== undefined && /^\d+\.\d+\.\d+$/u.test(installation.version), "MCP resume control requires the native version");
  // https://github.com/MoonshotAI/kimi-code/issues/5036: restore aligned declarations once fixed.
  const stale = versionAtLeast(installation.version, "2.5.0");
  const http = await startHttpEcho();
  const env = await startKimiAimock(mock => {
    for (const phase of ["seed", "resume"]) {
      echoFixtures(mock, new RegExp(`probe-${phase}`, "u"), ["echo", "remote"].map(server => ({ server, text: `${phase}-${server}` })));
    }
  });
  const cwd = env.env.HOME; assert.ok(cwd !== undefined);
  const sessions: Session[] = [];
  try {
    const initial = await kimiRuntime.session(installation, { cwd, env: env.env, mcpServers: echoServers(http.url) }); sessions.push(initial);
    await structuralToolRound(initial, env.mock, "probe-seed"); await initial.dispose();
    const replacements: readonly McpServer[] = [stdioEcho("echo", replacementStdio), { name: "remote", type: "http", url: http.url, headers: { Authorization: replacementHttp } }];
    const resumed = await kimiRuntime.session(installation, { cwd, env: env.env, resume: initial.id, ...(mode === "omitted" ? {} : { mcpServers: mode === "empty" ? [] : replacements }) }); sessions.push(resumed);
    const before = env.raw.length;
    await structuralToolRound(resumed, env.mock, "probe-resume"); await resumed.dispose();
    const requests = env.raw.slice(before);
    expect(declarations(requests[0])).toEqual(stale || mode === "replacement" ? names : []);
    for (const server of ["echo", "remote"] as const) {
      const expected = mode === "replacement"
        ? `echo:resume-${server} via=${server === "echo" ? "stdio" : "http"} token=${fingerprint(server === "echo" ? replacementStdio : replacementHttp)}`
        : `<system>ERROR: Tool execution failed.</system>\nTool "mcp__${server}__echo" not found`;
      const observed = results(requests, `call_resume-${server}`).map(value => typeof value === "string" ? value.replace(/^Wall time: \d+(?:\.\d+)? seconds\n/u, "") : value);
      expect(observed).toEqual([expected]);
    }
    const records = JSON.stringify(sessions.flatMap(session => session.records()));
    for (const secret of [replacementStdio, replacementHttp, "oar-replacement-http"]) { expect(records).not.toContain(secret); }
  } finally {
    for (const session of sessions) { await session.dispose(); }
    await env.stop(); http.stop();
  }
});
