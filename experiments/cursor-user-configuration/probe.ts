/** Real SDK through OAR, synthetic stored login, local backend, no inference. See README.md. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CursorAgent } from "../../packages/oar/src/runtimes/cursor/sdk.js";
import { openCursorAgent } from "../../packages/oar/src/runtimes/cursor/model.js";
import { observeLocalOnly } from "./observers.js";
import { configurationBackend, KEY } from "./backend.js";

const root = await mkdtemp(path.join(tmpdir(), "oar-cursor-config-"));
const cwd = path.join(root, "project");
const home = path.join(root, "home");
await Promise.all([mkdir(cwd), mkdir(home)]);
for (const key of ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"]) { delete process.env[key]; }
Object.assign(process.env, {
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".data"), XDG_CACHE_HOME: path.join(home, ".cache"),
  APPDATA: path.join(home, "roaming"), LOCALAPPDATA: path.join(home, "local"), CURSOR_DATA_DIR: path.join(home, "cursor-data"),
  CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON: JSON.stringify([{ id: "gpt-5.4-nano" }]),
});
const backend = await configurationBackend();
const observer = observeLocalOnly(backend.port);
process.env.CURSOR_BACKEND_URL = backend.url;
process.env.CURSOR_WEBSITE_URL = backend.url;

try {
  const sdk = await import("@cursor/sdk");
  const authFile = sdk.getDefaultSdkAuthPath();
  assert.equal(authFile, path.join(home, ".cursor", "sdk", "auth.json"));
  await new sdk.FileCredentialStore().save({ version: 1, backendUrl: backend.url, apiKey: KEY, apiKeyExpiresAtMs: Date.now() + 86_400_000, email: "fixture@example.invalid", createdAtMs: Date.now() });
  await writeConfiguration();
  const credential = await readFile(authFile, "utf8");
  const options = { cwd, model: "gpt-5.4-nano" };
  await observed("oar default", ["project", "user"], async () => { const agent = await openCursorAgent(sdk, options); return agent; });
  await observed("oar include", ["project", "user"], async () => { const agent = await openCursorAgent(sdk, { ...options, userConfiguration: "include" }); return agent; });
  await observed("native omitted control", [], async () => { const agent = await sdk.Agent.create({ model: { id: options.model }, local: { cwd, sandboxOptions: { enabled: false } } }); return agent; });
  await observed("native user positive control", ["user"], async () => { const agent = await sdk.Agent.create({ model: { id: options.model }, local: { cwd, sandboxOptions: { enabled: false }, settingSources: ["user"] } }); return agent; });
  await observed("oar exclude", [], async () => { const agent = await openCursorAgent(sdk, { ...options, userConfiguration: "exclude" }); return agent; });
  await observed("oar exclude after reopen", [], async () => { const agent = await openCursorAgent(sdk, { ...options, userConfiguration: "exclude" }); return agent; });
  assert.equal(await readFile(authFile, "utf8"), credential);
  const status = await sdk.Cursor.auth.status();
  assert.equal(status.status, "logged-in");
  console.log(JSON.stringify({ credentialFileUnchangedAfterDisposalAndReopen: true, originalLoginStillPresent: true, inferencePerformed: false }));
} finally {
  observer.restore();
  await backend.close();
  await rm(root, { recursive: true, force: true });
}

async function writeConfiguration(): Promise<void> {
  const hookScript = path.join(root, "hook.cjs");
  await writeFile(hookScript, `require("node:fs").writeFileSync(require("node:path").join(__dirname, process.argv[2] + "-hook-ran"), "executed");`);
  await Promise.all((["user", "project"] as const).map(async (scope) => {
    const directory = scope === "user" ? home : cwd;
    const files = {
      "skills/config-probe/SKILL.md": `---\nname: ${scope}-config-probe\ndescription: ${scope} skill marker\n---\nSynthetic skill\n`,
      "rules/config-probe.mdc": `---\nalwaysApply: true\n---\n${scope} rule marker\n`,
      "hooks.json": JSON.stringify({ version: 1, hooks: { beforeSubmitPrompt: [{ command: `"${process.execPath}" "${hookScript}" ${scope}` }] } }),
      "mcp.json": JSON.stringify({ mcpServers: { [`${scope}_config_mcp`]: { url: `${backend.url}/${scope}-mcp` } } }),
      "cli-config.json": JSON.stringify({ model: { id: `${scope}-different-model` } }),
      "sandbox.json": JSON.stringify({ enabled: true }),
    };
    await Promise.all(Object.entries(files).map(async ([name, content]) => {
      const file = path.join(directory, ".cursor", name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }));
    await writeFile(path.join(directory, "AGENTS.md"), `${scope} agents marker\n`);
  }));
}

// Each observation uses actual SDK files, configuration loaders, hooks and MCP transport.
// oxlint-disable-next-line max-statements -- Keep the measured effects and their assertions together.
async function observed(label: string, sources: readonly string[], open: () => Promise<CursorAgent>): Promise<void> {
  observer.reads.length = 0;
  backend.seen.length = 0;
  await Promise.all(["user", "project"].map(async scope => { await rm(path.join(root, `${scope}-hook-ran`), { force: true }); }));
  const agent = await open();
  try {
    assert.equal(agent.model?.id, "gpt-5.4-nano");
    const run = await agent.send("configuration probe", { onDelta() {} });
    const result = await run.wait();
    assert.ok(typeof result === "object" && result !== null && "status" in result && result.status === "error");
    const reads = new Set(observer.reads.map((file) => path.relative(root, file)));
    const hookFiles = await readdir(root);
    const configuration = ["user", "project"].map(scope => {
      const prefix = scope === "user" ? "home" : "project";
      const included = sources.includes(scope);
      const read = (name: string): boolean => reads.has(path.join(prefix, name));
      for (const name of ["skills/config-probe/SKILL.md", "hooks.json", "mcp.json"]) {
        assert.equal(read(path.join(".cursor", name)), included, `${label}: ${scope}/${name}; reads: ${JSON.stringify([...reads])}`);
      }
      const mcpConnected = backend.seen.some(request => request.path === `/${scope}-mcp`);
      assert.equal(mcpConnected, included, `${label}: ${scope} MCP`);
      const hookExecuted = hookFiles.includes(`${scope}-hook-ran`);
      assert.equal(hookExecuted, included, `${label}: ${scope} hook`);
      const ruleRead = read(".cursor/rules/config-probe.mdc");
      const agentsRead = read("AGENTS.md");
      assert.equal(ruleRead, scope === "project" && included, `${label}: ${scope} rule`);
      assert.equal(agentsRead, scope === "project" && included, `${label}: ${scope} AGENTS.md`);
      const modelConfigRead = read(".cursor/cli-config.json");
      assert.equal(modelConfigRead, false, `${label}: ${scope} CLI model config`);
      return { scope, included, ruleRead, agentsRead, mcpConnected, hookExecuted, modelConfigRead };
    });
    assert.ok(backend.seen.some((request) => request.path === "/auth/exchange_user_api_key" && request.storedKey));
    assert.ok(backend.seen.some((request) => request.path.includes("AgentService/Run") && request.accessToken));
    assert.deepEqual(observer.blocked, []);
    console.log(JSON.stringify({ label, configuration, model: agent.model, storedLoginUsed: true, authenticatedRunReachedLocalBackend: true, terminalStatus: "error" }));
  } finally { agent.close(); }
}
