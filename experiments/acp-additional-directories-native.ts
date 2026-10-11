/* oxlint-disable typescript/promise-function-async -- Deadline callbacks return the native SDK promises. */
/** Native ACP roots on new and resumed sessions; isolated homes, synthetic provider, no account or paid model calls.
 * Run: pnpm tsx experiments/acp-additional-directories-native.ts <kimi|opencode> <absolute binary>
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAcpClient, methods, startAcpProcess, withAcpDeadline } from "../packages/oar/src/shared/acp/process.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { startKimiAimock } from "../sea-trial/harness/aimock-acp.js";

const [runtime, command] = process.argv.slice(2);
assert.ok((runtime === "kimi" || runtime === "opencode") && command !== undefined);
const root = await mkdtemp(path.join(tmpdir(), "oar-acp-dirs-"));
const cwd = path.join(root, "project");
const first = path.join(root, "first");
const second = path.join(root, "second");
const home = path.join(root, "home");
await Promise.all([cwd, first, second, home].map(async (dir) => { await mkdir(dir); }));
await writeFile(path.join(home, "config.toml"), `default_model = "oar-audit"\ntelemetry = false\n[providers.oar]\ntype = "openai"\nbase_url = "http://127.0.0.1:1/v1"\napi_key = "synthetic-probe"\n[models.oar-audit]\nprovider = "oar"\nmodel = "oar-audit"\nmax_context_size = 128000\ncapabilities = ["tool_use"]\n`);
const provider = runtime === "kimi" ? await startKimiAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); }) : undefined;
const app = createAcpClient({ name: "oar-directories" });
const start = (): ReturnType<typeof startAcpProcess> => startAcpProcess(command, ["acp"], app, {
  cwd,
  env: { PATH: globalThis.process.env.PATH, HOME: home, KIMI_CODE_HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), ...provider?.env },
});
let native = start();
const request = <T>(method: string, send: () => Promise<T>): Promise<T> => withAcpDeadline(native, method, 30_000, send);
const log = (phase: string, value: unknown): void => { console.log(JSON.stringify({ runtime, phase, value }).replaceAll(root, "<TMP>")); };
try {
  const initialized = await request("initialize", () => native.connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} }));
  log("initialize", initialized.agentCapabilities);
  assert.ok(asRecord(asRecord(initialized.agentCapabilities)?.sessionCapabilities)?.additionalDirectories !== undefined);
  const opened = await request("session/new", () => native.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [], additionalDirectories: [first] }));
  log("open", { sessionId: opened.sessionId });
  const checkList = async (phase: string, expected: readonly string[]): Promise<void> => {
    const response = await request("session/list", () => native.connection.agent.request(methods.agent.session.list, { cwd }));
    const entry = response.sessions.find((session) => session.sessionId === opened.sessionId);
    const directories = asRecord(entry)?.additionalDirectories ?? [];
    log(phase, { directories });
    if (runtime === "opencode") { assert.deepEqual(directories, expected); }
  };
  if (provider !== undefined) {
    await request("session/prompt", () => native.connection.agent.request(methods.agent.session.prompt, { sessionId: opened.sessionId, prompt: [{ type: "text", text: "Say ok" }] }));
    const body = JSON.stringify(provider.raw.at(-1)?.body);
    log("provider-new", { first: body.includes(JSON.stringify(first).slice(1, -1)), second: body.includes(JSON.stringify(second).slice(1, -1)) });
    assert.ok(body.includes(JSON.stringify(first).slice(1, -1)));
  }
  await checkList("list-new", [first]);
  await request("session/close", () => native.connection.agent.request(methods.agent.session.close, { sessionId: opened.sessionId }));
  native.kill(); await native.exited;
  native = start();
  await request("initialize", () => native.connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} }));
  if (runtime === "opencode") {
    await request("session/resume", () => native.connection.agent.request(methods.agent.session.resume, { sessionId: opened.sessionId, cwd, mcpServers: [] }));
    await checkList("list-cold-omitted", []);
    await request("session/close", () => native.connection.agent.request(methods.agent.session.close, { sessionId: opened.sessionId }));
  }
  log("resume", await request("session/resume", () => native.connection.agent.request(methods.agent.session.resume, { sessionId: opened.sessionId, cwd, mcpServers: [], additionalDirectories: [second] })));
  if (provider !== undefined) {
    await request("session/prompt", () => native.connection.agent.request(methods.agent.session.prompt, { sessionId: opened.sessionId, prompt: [{ type: "text", text: "Say ok again" }] }));
    const body = JSON.stringify(provider.raw.at(-1)?.body);
    log("provider-resume", { first: body.includes(JSON.stringify(first).slice(1, -1)), second: body.includes(JSON.stringify(second).slice(1, -1)) });
    assert.ok(!body.includes(JSON.stringify(second).slice(1, -1)));
  }
  await checkList("list-resume", [second]);
  await request("session/close", () => native.connection.agent.request(methods.agent.session.close, { sessionId: opened.sessionId }));
} finally { native.kill(); await native.exited; await provider?.stop(); await rm(root, { recursive: true, force: true }); }
