/* oxlint-disable max-statements -- One live run checks both transports in order. */
/**
 * BURNS TOKENS through an existing Cursor SDK login.
 * Run: pnpm tsx experiments/cursor-mcp.ts <new-output-directory>
 *
 * Does Cursor's local agent call a tool of a server given in
 * `Agent.create({ mcpServers })`? OAR refuses `SessionOptions.mcpServers` on
 * cursor until a run shows it (docs/runtimes/cursor.md#session-mcp-servers).
 * One stdio and one HTTP entry of the repo's echo MCP server
 * (tests/fixtures/echo-mcp-server.mjs), each with a synthetic credential;
 * one prompt asks for both calls. Only the echo server writes
 * `echo:<text> via=<transport> token=<fingerprint>`, so that string in the
 * run's tool results or answer means the agent ran the server, the result
 * came back, and the credential reached the server (by fingerprint only).
 * The user's and project's own MCP files are not read (`settingSources: []`).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Agent } from "@cursor/sdk";

const ECHO = path.join(import.meta.dirname, "..", "tests", "fixtures", "echo-mcp-server.mjs");
const STDIO_TOKEN = "synthetic-stdio-credential";
const HTTP_AUTHORIZATION = "Bearer synthetic-http-credential";
const fingerprint = (secret: string): string => createHash("sha256").update(secret).digest("hex").slice(0, 12);

const [outputArgument] = process.argv.slice(2);
assert.ok(outputArgument !== undefined && outputArgument !== "", "a new output directory is required");
const output = path.resolve(outputArgument);
mkdirSync(output, { mode: 0o700 });
const cwd = path.join(output, "workspace");
mkdirSync(cwd, { mode: 0o700 });
const log = (channel: string, value: unknown): void => { appendFileSync(path.join(output, "events.jsonl"), `${JSON.stringify({ at: Date.now(), channel, value })}\n`, { mode: 0o600 }); };

const server = spawn(process.execPath, [ECHO, "--http"], { stdio: ["ignore", "pipe", "inherit"] });
const lines = createInterface({ input: server.stdout });
let url = "";
for await (const line of lines) { url = line.replace(/^listening /u, ""); break; }
assert.ok(url.startsWith("http"), "the http echo server did not start");
const agent = await Agent.create({
  model: { id: process.env.OAR_TEST_MODEL ?? "gpt-5.4-nano" },
  local: { cwd, settingSources: [], sandboxOptions: { enabled: false } },
  mcpServers: {
    echo: { type: "stdio", command: process.execPath, args: [ECHO], env: { OAR_ECHO_TOKEN: STDIO_TOKEN } },
    remote: { type: "http", url, headers: { Authorization: HTTP_AUTHORIZATION } },
  },
});
try {
  const run = await agent.send("Call the `echo` tool of the MCP server named echo with text 'cursor-stdio-probe', then the `echo` tool of the MCP server named remote with text 'cursor-http-probe'. Then reply with both tool results verbatim, one per line.");
  const seen: string[] = [];
  for await (const message of run.stream()) {
    log("stream", message);
    seen.push(JSON.stringify(message));
  }
  const result = await run.wait();
  log("wait", result);
  const all = seen.join("\n");
  const expected = {
    stdio: `echo:cursor-stdio-probe via=stdio token=${fingerprint(STDIO_TOKEN)}`,
    http: `echo:cursor-http-probe via=http token=${fingerprint(HTTP_AUTHORIZATION)}`,
  };
  const report = { status: result.status, stdio: all.includes(expected.stdio), http: all.includes(expected.http), credentialLeaked: all.includes(STDIO_TOKEN) || all.includes("synthetic-http-credential") };
  writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report));
  assert.deepEqual(report, { status: "finished", stdio: true, http: true, credentialLeaked: false }, `inspect ${output}`);
  console.log(`PASS Cursor called both attached MCP servers; evidence: ${output}`);
} finally {
  await agent[Symbol.asyncDispose]();
  server.kill();
}
