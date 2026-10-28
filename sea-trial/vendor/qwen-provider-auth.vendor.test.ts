import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createQwenProviderAuth, qwenRuntime } from "../../packages/oar/src/index.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";

const key = "oar-synthetic-native-provider-key";
async function fixture() {
  const installation = await qwenRuntime.installation();
  if (installation.kind !== "available" || installation.via !== "executable") { throw new Error("Qwen executable is required"); }
  const home = await mkdtemp(path.join(tmpdir(), "oar-qwen-providers-"));
  const cwd = path.join(home, "workspace");
  await mkdir(cwd);
  await mkdir(path.join(home, ".qwen"));
  const env: Record<string, string | null> = Object.fromEntries(Object.keys(process.env).map((name) => [name, null]));
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) { env[name] = process.env[name]; }
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, QWEN_HOME: path.join(home, ".qwen"),
    QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(home, "system.json"), QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(home, "defaults.json"),
    QWEN_CODE_TELEMETRY_ENABLED: "false", NO_PROXY: "*" });
  return { installation, home, cwd, env,
    stop: async () => { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); },
  };
}
async function settings(file: string): Promise<JsonRecord> {
  try { return asRecord(JSON.parse(await readFile(file, "utf8"))) ?? {}; }
  catch (error) { if (asRecord(error)?.code === "ENOENT") { return {}; } throw error; }
}

describe.skipIf(process.env.OAR_TEST !== "qwen-aimock")("Qwen native provider settings", () => {
  test("existingConfig reports settings metadata, not environment credentials or authentication", async () => {
    const local = await fixture();
    try {
      const auth = await createQwenProviderAuth(local.installation, { cwd: local.cwd, env: { ...local.env, DEEPSEEK_API_KEY: key } });
      const environmental = await auth.listProviders();
      expect(environmental.find((provider) => provider.id === "deepseek")?.existingConfig).toBeUndefined();
      const file = path.join(local.home, ".qwen/settings.json");
      await writeFile(file, JSON.stringify({ $version: 4, env: { DEEPSEEK_API_KEY: key } }));
      const settingsProviders = await auth.listProviders();
      const configured = settingsProviders.find((provider) => provider.id === "deepseek");
      expect(configured?.existingConfig).toMatchObject({ hasApiKey: true });
      expect(JSON.stringify(configured)).not.toContain(key);
      await writeFile(file, JSON.stringify({ $version: 4, modelProviders: { openai: [{ id: "deepseek-v4-pro", name: "[DeepSeek] deepseek-v4-pro", baseUrl: "https://api.deepseek.com", envKey: "DEEPSEEK_API_KEY" }] } }));
      const modelProviders = await auth.listProviders();
      const onlyModels = modelProviders.find((provider) => provider.id === "deepseek")?.existingConfig;
      expect(onlyModels).toMatchObject({ modelIds: ["deepseek-v4-pro"] });
      expect(onlyModels?.hasApiKey).toBeUndefined();
    } finally { await local.stop(); }
  }, 120_000);

  test.each(["user", "workspace"] as const)("connect persists in native %s scope and reuses a key across reader processes", async (scope) => {
    const local = await fixture();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "synthetic unauthorized" } }));
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") { throw new Error("loopback provider unavailable"); }
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const auth = await createQwenProviderAuth(local.installation, { cwd: local.cwd, env: local.env });
      const params = { providerId: "custom-openai-compatible", baseUrl, protocol: "openai", wireApi: "chat-completions", modelIds: ["fixture-model"], scope } as const;
      expect(await auth.connect({ ...params, apiKey: key })).toMatchObject({ success: true, providerId: params.providerId, modelId: "fixture-model", authType: "openai" });
      const listed = await auth.listProviders();
      expect(listed.find((provider) => provider.id === params.providerId)?.existingConfig).toMatchObject({ hasApiKey: true, baseUrl, modelIds: ["fixture-model"] });
      expect(JSON.stringify(listed)).not.toContain(key);
      expect(await auth.connect(params)).toMatchObject({ success: true, modelId: "fixture-model" });
      const user = await settings(path.join(local.home, ".qwen/settings.json"));
      const workspace = await settings(path.join(local.cwd, ".qwen/settings.json"));
      expect(Object.values(asRecord(user.env) ?? {}).includes(key)).toBe(scope === "user");
      expect(Object.values(asRecord(workspace.env) ?? {}).includes(key)).toBe(scope === "workspace");
      expect(requests).toBe(0);
      await expect(auth.connect({ ...params, providerId: `unknown-${key}`, apiKey: key })).rejects.toMatchObject({ kind: "native", code: -32_602 });
    } finally { server.closeAllConnections(); server.close(); await local.stop(); }
  }, 120_000);
});
