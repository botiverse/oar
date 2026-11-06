import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { asRecord, asRecordList, parseJson } from "../../../packages/oar/src/shared/json.js";
import type { McpServer } from "../../../packages/oar/src/contracts/session.js";
import { lastInput, type ProviderRequest, type Reply } from "./dsh-provider.js";

export const echoServer = path.resolve(import.meta.dirname, "../../../tests/fixtures/echo-mcp-server.mjs");
export const mcp = (name: string): McpServer => ({ name, command: process.execPath, args: [echoServer] });
export const configuredMcp = { insert: [{ id: "configured-mcp", name: "@deepseek-ai/dsh-mcp-client", config: {
  transport: "stdio", serverName: "configured", command: process.execPath, args: [echoServer], failOnStartupError: true,
} }] };

/** A result must actually return through the native MCP client before the model finishes. */
export function mcpReply(request: ProviderRequest): Reply {
  const match = /MCP:(\w+):(\w+)/u.exec(lastInput(request));
  if (match === null) { return { kind: "say", text: "no session MCP requested" }; }
  const [, server, marker] = match;
  const result = request.messages.some(message => message.role === "tool" && JSON.stringify(message.content).includes(`echo:${String(marker)} via=stdio token=none`));
  if (request.messages.at(-1)?.role === "tool") { return { kind: "say", text: result ? "MCP_DONE" : "MCP_FAILED" }; }
  return { kind: "tool", name: `mcp__${String(server)}__echo`, arguments: { text: marker ?? "" } };
}

export function mcpNames(request: ProviderRequest): readonly string[] {
  return asRecordList(request.body.tools).map(tool => asRecord(tool.function)?.name).filter((name): name is string => typeof name === "string" && name.startsWith("mcp__")).toSorted();
}

/** Capture only this fixture's own child, with its actual cwd and literal arguments. */
export async function trackedMcp(cwd: string): Promise<{ readonly server: McpServer; readonly read: () => Promise<{ pid: number; cwd: string; args: unknown }> }> {
  const wrapper = path.join(cwd, "tracked-mcp.mjs");
  const log = path.join(cwd, "mcp-start.json");
  await writeFile(wrapper, `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], JSON.stringify({pid:process.pid,cwd:process.cwd(),args:process.argv.slice(3)}));\nawait import(${JSON.stringify(pathToFileURL(echoServer).href)});\n`);
  return {
    server: { name: "echo", command: process.execPath, args: [wrapper, log, "a b", "$(not-a-command)", ""] },
    read: async () => {
      const value = asRecord(parseJson(await readFile(log, "utf8")));
      assert.ok(typeof value?.pid === "number" && typeof value.cwd === "string");
      return { pid: value.pid, cwd: value.cwd, args: value.args };
    },
  };
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
