/* oxlint-disable max-statements -- One live run checks both transports in order. */
/**
 * BURNS TOKENS through an existing Cursor SDK login.
 * Run: pnpm tsx experiments/cursor-mcp.ts <new-output-directory>
 *
 * Does Cursor's local agent call a tool of a server given in
 * `Agent.create({ mcpServers })`? OAR refuses `SessionOptions.mcpServers` on
 * cursor until a run shows it (docs/runtimes/cursor.md#session-mcp-servers).
 * On create and again after `Agent.resume`, one stdio and one HTTP entry of the repo's echo MCP server
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
const options = {
  model: { id: process.env.OAR_TEST_MODEL ?? "gpt-5.4-nano" },
  local: { cwd, settingSources: [], sandboxOptions: { enabled: false } },
  mcpServers: {
    echo: { type: "stdio" as const, command: process.execPath, args: [ECHO], env: { OAR_ECHO_TOKEN: STDIO_TOKEN } },
    remote: { type: "http" as const, url, headers: { Authorization: HTTP_AUTHORIZATION } },
  },
};
const expected = (label: string): { readonly stdio: string; readonly http: string } => ({
  stdio: `echo:${label}-stdio via=stdio token=${fingerprint(STDIO_TOKEN)}`,
  http: `echo:${label}-http via=http token=${fingerprint(HTTP_AUTHORIZATION)}`,
});

/** One run asking for both calls: whether each echo came back in the stream, and in a tool-call delta. */
async function round(agent: Awaited<ReturnType<typeof Agent.create>>, label: string): Promise<Record<string, unknown>> {
  const deltas: string[] = [];
  const run = await agent.send(`Call the \`echo\` tool of the MCP server named echo with text '${label}-stdio', then the \`echo\` tool of the MCP server named remote with text '${label}-http'. Then reply with both tool results verbatim, one per line.`, {
    onDelta: ({ update }) => { log(`${label}:delta`, update); deltas.push(JSON.stringify(update)); },
  });
  const seen: string[] = [];
  for await (const message of run.stream()) { log(`${label}:stream`, message); seen.push(JSON.stringify(message)); }
  const result = await run.wait();
  log(`${label}:wait`, result);
  const want = expected(label);
  const all = [...seen, ...deltas].join("\n");
  const toolDeltas = deltas.filter((delta) => delta.includes("tool"));
  return {
    status: result.status,
    stdio: all.includes(want.stdio),
    http: all.includes(want.http),
    toolCallDeltaNamesEcho: toolDeltas.some((delta) => delta.includes("echo")),
    credentialLeaked: all.includes(STDIO_TOKEN) || all.includes("synthetic-http-credential"),
  };
}

const report: Record<string, unknown> = {};
let agentId = "";
try {
  const created = await Agent.create(options);
  ({ agentId } = created);
  try { report.open = await round(created, "open"); } finally { await created[Symbol.asyncDispose](); }
  const resumed = await Agent.resume(agentId, options);
  try { report.resume = await round(resumed, "resume"); } finally { await resumed[Symbol.asyncDispose](); }
} finally { server.kill(); }
writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report));
const pass = { status: "finished", stdio: true, http: true, toolCallDeltaNamesEcho: true, credentialLeaked: false };
assert.deepEqual(report, { open: pass, resume: pass }, `inspect ${output}`);
console.log(`PASS Cursor called both attached MCP servers on open and after resume; evidence: ${output}`);
