/** Native ACP/MCP controls with fresh homes and a local model fixture. */
/* oxlint-disable eslint/no-await-in-loop -- Compare ordered native runs without concurrent startup load. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAcpClient, methods, startAcpProcess, withAcpDeadline } from "../../packages/oar/src/shared/acp/process.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startAntigravityAimock } from "../../sea-trial/harness/aimock-acp.js";
import { echoFixtures, echoesReceived, ECHO_SERVER } from "../../sea-trial/vendor/support/echo-mcp.js";
import { copyLogs, type Mark, type Wire, summarize } from "./support.js";

const [binaryArg, outputArg] = process.argv.slice(2);
assert.ok(binaryArg !== undefined && outputArg !== undefined,
  "Usage: pnpm tsx experiments/antigravity-mcp-readiness/probe.ts <absolute agy path> <new private output dir>");
assert.ok(path.isAbsolute(binaryArg));
const binary: string = binaryArg;
const output = path.resolve(outputArg);
await mkdir(output, { recursive: false, mode: 0o700 });
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "LANG", "LC_ALL", "TMPDIR", "SystemRoot", "SYSTEMROOT"].includes(key)));
const wrapper = path.join(import.meta.dirname, "delayed-echo.mjs");
const all: JsonRecord[] = [];

type Configuration = "session-only" | "other-user" | "same-name";

async function run(config: Configuration, delayMs: number): Promise<JsonRecord> {
  const name = `${config}-${String(delayMs)}`;
  const dir = path.join(output, name);
  await mkdir(dir, { mode: 0o700 });
  process.env.OAR_TRIAL_RUN_DIR = dir;
  const wire: Wire[] = [];
  const marks: Mark[] = [];
  const stamp = (event: string, extra: JsonRecord = {}): void => { marks.push({ at: Date.now(), event, ...extra }); };
  const args = (server: string): string[] => [wrapper, ECHO_SERVER, String(delayMs), path.join(dir, `${server}.jsonl`)];
  const userEntry = (server: string): JsonRecord => ({ command: process.execPath, args: args(server) });
  const userMcp = config === "session-only" ? undefined : { mcpServers: {
    ...(config === "same-name" ? { echo: userEntry("user-echo") } : {}),
    userecho: userEntry("userecho"),
  } };
  const fixture = await startAntigravityAimock((mock) => {
    echoFixtures(mock, /READINESS_FIRST/u, [
      { server: "echo", text: "first-session" },
      ...(config === "session-only" ? [] : [{ server: "userecho", text: "first-user" }]),
    ], (server, text) => server === "userecho"
      ? { name: "call_mcp_tool", arguments: { ServerName: server, ToolName: "echo", Arguments: { text } } }
      : { name: `mcp_${server}_echo`, arguments: { text, toolSummary: "Echo test marker" } });
    mock.on({ predicate: (request) => JSON.stringify(request.messages).includes("READINESS_SECOND") }, { content: "second done" });
    mock.on({ predicate: () => true }, { content: "title" });
  }, userMcp);
  const { HOME: home, GEMINI_HOME: geminiHome } = fixture.env;
  assert.ok(home !== undefined && geminiHome !== undefined);
  const native = startAcpProcess(binary, ["acp", "--dangerously-skip-permissions", "--process-per-session"],
    createAcpClient({ name: "oar" }).onNotification(methods.client.session.update, () => {}), {
      cwd: home, env: { ...inherited, ...fixture.env },
      incoming: (message) => { wire.push({ at: Date.now(), direction: "in", message }); return message; },
      outgoing: (message) => { wire.push({ at: Date.now(), direction: "out", message }); },
    });
  const request = async (method: string, params: JsonRecord): Promise<JsonRecord> =>
    asRecord(await withAcpDeadline(native, method, 30_000, async (options) => {
      const response = await native.connection.agent.request(method, params, options);
      return response;
    })) ?? {};
  let initialized: JsonRecord = {};
  let opened: JsonRecord = {};
  let failure: string | undefined = undefined;
  const timer = setTimeout(() => { native.kill(); }, 45_000);
  timer.unref();
  try {
    initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "oar", version: "0.0.0" } });
    stamp("opening");
    opened = await request("session/new", { cwd: home, mcpServers: [{ name: "echo", command: process.execPath, args: args("session-echo"), env: [] }] });
    stamp("opened");
    stamp("first_prompt");
    const first = await request("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "READINESS_FIRST" }] });
    stamp("first_finished", { response: first });
    // Observation window only: the first prompt has already completed.
    await delay(delayMs + 500);
    stamp("second_prompt");
    const second = await request("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "READINESS_SECOND" }] });
    stamp("second_finished", { response: second });
    await request("session/close", { sessionId: opened.sessionId });
    stamp("closed");
  } catch (error) {
    failure = String(error);
    stamp("error", { failure });
  } finally {
    clearTimeout(timer);
    native.kill();
    await native.exited;
    // Save private evidence before removing the isolated home, even on a failure.
    try {
      await copyLogs(geminiHome, dir);
      await writeFile(path.join(dir, "private.json"), JSON.stringify({ version, config, delayMs, wire, marks, raw: fixture.raw, diagnostics: native.diagnostics(), failure }, null, 2), { mode: 0o600 });
    } finally {
      await fixture.stop();
    }
  }
  const result = summarize({ name, version, delayMs, opened, initialized, wire, marks, raw: fixture.raw, echoes: echoesReceived(fixture.raw), failure });
  const { echoes } = result;
  assert.ok(Array.isArray(echoes));
  const sessionEcho = echoes.some((value) => typeof value === "string" && value.includes("first-session"));
  const userEcho = echoes.some((value) => typeof value === "string" && value.includes("first-user"));
  const ok = failure === undefined && sessionEcho && (config === "session-only" || userEcho) && result.unknownTool === false;
  console.log(JSON.stringify({ case: name, version, sessionEcho, userEcho, unknownTool: result.unknownTool, ok, failure }));
  return { ...result, ok };
}

for (const config of ["session-only", "other-user", "same-name"] as const) {
  for (const delayMs of [0, 1000]) {
    all.push(await run(config, delayMs));
    await writeFile(path.join(output, "selected.json"), JSON.stringify(all, null, 2));
  }
}
if (all.some((result) => result.ok !== true)) { process.exitCode = 1; }
