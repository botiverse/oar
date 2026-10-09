import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createPiProviderAuth } from "../../packages/oar/src/runtimes/pi/auth.js";
import { createPiModelCatalog } from "../../packages/oar/src/runtimes/pi/catalog.js";
import { piAgentDir } from "../../packages/oar/src/runtimes/pi/resolve.js";

// oar#289: with OAR_PI_AGENT_DIR set, the facades read and write the agent
// dir's auth.json and models.json, the ones sessions use, not pi's own dir.

let piHome = "";
let agentDir = "";

beforeEach(() => {
  piHome = mkdtempSync(join(tmpdir(), "oar-pi-home-"));
  agentDir = mkdtempSync(join(tmpdir(), "oar-pi-agent-"));
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "fake-key" } }), { mode: 0o600 });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "oar-local": {
    name: "oar-local", baseUrl: "http://127.0.0.1:9", apiKey: "fake-local-key", api: "anthropic-messages",
    models: [{ id: "local-model", name: "local-model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 16_384 }],
  } } }));
  vi.stubEnv("PI_CODING_AGENT_DIR", piHome);
  vi.stubEnv("OAR_PI_AGENT_DIR", agentDir);
});
afterEach(() => { vi.unstubAllEnvs(); });

test("provider auth reads and writes the agent dir's auth.json, leaving pi's own dir alone", async () => {
  const auth = await createPiProviderAuth();
  expect(await auth.status("deepseek")).toMatchObject({ configured: true, method: "api_key" });
  await auth.setApiKey("groq", "fake-groq-key");
  const stored: unknown = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
  expect(stored).toHaveProperty("deepseek");
  expect(stored).toHaveProperty("groq");
  expect(existsSync(join(piHome, "auth.json"))).toBe(false);
});

test("the model catalog reads the agent dir's models.json; null still disables it", async () => {
  const catalog = await createPiModelCatalog();
  expect(catalog.providers().find((provider) => provider.id === "oar-local")).toMatchObject({ configured: true });
  const withoutModels = await createPiModelCatalog({ modelsPath: null });
  expect(withoutModels.providers().some((provider) => provider.id === "oar-local")).toBe(false);
});

test("explicit paths still win over the agent dir", async () => {
  const other = mkdtempSync(join(tmpdir(), "oar-pi-explicit-"));
  const auth = await createPiProviderAuth({ authPath: join(other, "auth.json"), modelsPath: null });
  const status = await auth.status("deepseek");
  expect(status.configured).toBe(false);
});

test("an empty OAR_PI_AGENT_DIR counts as unset: pi's own dir, never a relative path", async () => {
  expect(piAgentDir(() => "/pi-own")).toBe(agentDir);
  vi.stubEnv("OAR_PI_AGENT_DIR", "");
  expect(piAgentDir(() => "/pi-own")).toBe("/pi-own");
  const auth = await createPiProviderAuth();
  await auth.setApiKey("groq", "fake-groq-key");
  expect(existsSync(join(piHome, "auth.json"))).toBe(true);
  const relative = join(process.cwd(), "auth.json");
  expect(existsSync(relative)).toBe(false);
});
