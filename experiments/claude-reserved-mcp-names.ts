/**
 * Recheck Claude's native handling of the five MCP server names OAR refuses
 * (#395), with a normal name as the control. OAR's public session and server
 * entry points reject the names before launch, so this deliberately sends
 * them directly through the native --mcp-config channel. No real credentials
 * or model calls: a fresh home, served echo tool and local scripted provider.
 *
 * Run: OAR_CLAUDE_BIN=/path/to/claude pnpm tsx experiments/claude-reserved-mcp-names.ts
 * Prints only the supplied name, native MCP status, direct or searchable tool names and
 * result subtype, never the full initialization answer or provider request.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeInstallation, serveMcpTools } from "../packages/oar/src/index.js";
import { claudeMcpConfig } from "../packages/oar/src/runtimes/claude/mcp-config.js";
import { spawnLineProcess } from "../packages/oar/src/shared/executable/index.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { startClaudeAimock } from "../sea-trial/harness/aimock.js";
import { claudeMcpCatalog } from "../sea-trial/vendor/support/claude-tools.js";

async function probe(command: string, name: string): Promise<unknown> {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-claude-mcp-name-"));
  const provider = await startClaudeAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); }, { captureRaw: true });
  const served = await serveMcpTools({
    name: "plainname",
    tools: [{ name: "ping", description: "Return ok", inputSchema: { type: "object", properties: {} }, handler: (): string => "ok" }],
  });
  try {
    const config = path.join(directory, "mcp.json");
    await writeFile(config, JSON.stringify(claudeMcpConfig([{ ...served.server, name }])), { mode: 0o600 });
    const child = spawnLineProcess(command, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--mcp-config", config], {
      cwd: directory,
      env: {
        ...process.env, ...provider.env,
        HOME: directory, CLAUDE_CONFIG_DIR: path.join(directory, "config"),
        ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      killTree: true,
    });
    const result = Promise.withResolvers<string>();
    let servers: unknown = null;
    const timeout = setTimeout(() => { result.resolve("timeout_before_result"); }, 30_000);
    child.onLine((line) => {
      const frame = asRecord(JSON.parse(line));
      if (frame?.type === "system" && frame.subtype === "init") {
        servers = Array.isArray(frame.mcp_servers) ? frame.mcp_servers.map((server) => {
          const entry = asRecord(server);
          return { name: entry?.name, status: entry?.status };
        }) : null;
      }
      if (frame?.type === "result") { result.resolve(String(frame.subtype)); }
    });
    child.onExit(() => { result.resolve("exited_before_result"); });
    try {
      await child.spawned;
      child.write(`${JSON.stringify({ type: "user", message: { role: "user", content: "Reply ok." } })}\n`);
      const subtype = await result.promise;
      assert.equal(subtype, "success");
      const tools = provider.raw.flatMap(({ body }) => {
        const catalog = claudeMcpCatalog(body);
        return [...catalog.schemas, ...catalog.searchable];
      });
      if (name === "plainname") { assert.ok(tools.includes("mcp__plainname__ping")); }
      else { assert.deepEqual(tools, [], "A refused name must be absent from direct and deferred catalogs"); }
      return { name, servers, tools: [...new Set(tools)], result: subtype };
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
    }
  } finally {
    await served.close();
    await provider.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

const installation = await claudeInstallation();
assert.ok(installation.kind === "available" && installation.via === "executable");
for (const name of ["plainname", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]) {
  // oxlint-disable-next-line no-await-in-loop -- one native process per name keeps each result attributable.
  console.log(JSON.stringify(await probe(installation.command, name)));
}
