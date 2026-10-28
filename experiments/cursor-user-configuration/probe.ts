/** Real SDK through OAR, synthetic stored login, local backend, no inference. See README.md. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CursorAgent } from "../../packages/oar/src/runtimes/cursor/sdk.js";
import { openCursorAgent } from "../../packages/oar/src/runtimes/cursor/model.js";
import { observeLocalOnly } from "./observers.js";
import { configurationBackend, KEY } from "./backend.js";

const root = await mkdtemp(path.join(tmpdir(), "oar-cursor-config-"));
const cwd = path.join(root, "project");
await mkdir(cwd);
for (const key of ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"]) { delete process.env[key]; }
Object.assign(process.env, {
  HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, ".config"),
  XDG_DATA_HOME: path.join(root, ".data"), XDG_CACHE_HOME: path.join(root, ".cache"),
  APPDATA: path.join(root, "roaming"), LOCALAPPDATA: path.join(root, "local"), CURSOR_DATA_DIR: path.join(root, "cursor-data"),
  CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON: JSON.stringify([{ id: "gpt-5.4-nano" }]),
});
const backend = await configurationBackend();
const observer = observeLocalOnly(backend.port);
process.env.CURSOR_BACKEND_URL = backend.url;
process.env.CURSOR_WEBSITE_URL = backend.url;

try {
  const sdk = await import("@cursor/sdk");
  const authFile = sdk.getDefaultSdkAuthPath();
  assert.equal(authFile, path.join(root, ".cursor", "sdk", "auth.json"));
  await new sdk.FileCredentialStore().save({ version: 1, backendUrl: backend.url, apiKey: KEY, apiKeyExpiresAtMs: Date.now() + 86_400_000, email: "fixture@example.invalid", createdAtMs: Date.now() });
  await writeConfiguration();
  const credential = await readFile(authFile, "utf8");
  const options = { cwd, model: "gpt-5.4-nano" };
  await observed("oar default", false, async () => { const agent = await openCursorAgent(sdk, options); return agent; });
  await observed("native user positive control", true, async () => { const agent = await sdk.Agent.create({ model: { id: options.model }, local: { cwd, sandboxOptions: { enabled: false }, settingSources: ["user"] } }); return agent; });
  await observed("oar exclude", false, async () => { const agent = await openCursorAgent(sdk, { ...options, userConfiguration: "exclude" }); return agent; });
  await observed("oar exclude after reopen", false, async () => { const agent = await openCursorAgent(sdk, { ...options, userConfiguration: "exclude" }); return agent; });
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
  const files = {
    "skills/config-probe/SKILL.md": "---\nname: config-probe\ndescription: USER_SKILL_CONFIG_SENTINEL\n---\nUser skill sentinel\n",
    "rules/config-probe.mdc": "---\nalwaysApply: true\n---\nUSER_RULE_CONFIG_SENTINEL\n",
    "agents/config-probe.md": "---\nname: config-probe\ndescription: User agent sentinel\n---\nUser agent sentinel\n",
    "hooks.json": JSON.stringify({ version: 1, hooks: { beforeSubmitPrompt: [{ command: "echo USER_HOOK_CONFIG_SENTINEL" }] } }),
    "mcp.json": JSON.stringify({ mcpServers: { user_config_mcp: { url: `${backend.url}/user-mcp` } } }),
    "sandbox.json": JSON.stringify({ enabled: true }),
  };
  await Promise.all(Object.entries(files).map(async ([name, content]) => {
    const file = path.join(root, ".cursor", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }));
}

async function observed(label: string, include: boolean, open: () => Promise<CursorAgent>): Promise<void> {
  observer.reads.length = 0;
  backend.seen.length = 0;
  const agent = await open();
  try {
    const run = await agent.send("configuration probe", { onDelta() {} });
    const result = await run.wait();
    assert.ok(typeof result === "object" && result !== null && "status" in result && result.status === "error");
    const reads = new Set(observer.reads.map((file) => path.relative(root, file)));
    for (const name of ["skills/config-probe/SKILL.md", "hooks.json", "mcp.json"]) {
      assert.equal(reads.has(path.join(".cursor", name)), include, `${label}: ${name}; observed reads: ${JSON.stringify([...reads])}`);
    }
    assert.equal(backend.seen.some((request) => request.path === "/user-mcp"), include);
    assert.ok(backend.seen.some((request) => request.path === "/auth/exchange_user_api_key" && request.storedKey));
    assert.ok(backend.seen.some((request) => request.path.includes("AgentService/Run") && request.accessToken));
    assert.deepEqual(observer.blocked, []);
    console.log(JSON.stringify({ label, userConfigurationRead: include, userMcpConnected: include, storedLoginUsed: true, authenticatedRunReachedLocalBackend: true, terminalStatus: "error" }));
  } finally { agent.close(); }
}
