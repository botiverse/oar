import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai-durable/models";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { createCursorRuntime, defaultRuntimes, type Runtime } from "../packages/oar/src/index.js";
import { createPiDurableRuntime } from "../packages/oar/src/pi-durable.js";
import { piCredentials } from "../packages/oar/src/runtimes/pi/credential-shape.js";

async function withAllRuntimes(run: (runtimes: readonly Runtime[]) => void): Promise<void> {
  const models = createModels();
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  const durable = createPiDurableRuntime({ harness, models });
  const cursor = createCursorRuntime({ sdk: async () => { throw new Error("unused"); } });
  try {
    run([...defaultRuntimes.list(), cursor, durable]);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

function storeDirectoryEnvs(runtime: Runtime): string[] {
  const names: string[] = [];
  for (const store of runtime.credentials?.stores ?? []) {
    if (store.directoryEnv !== undefined) { names.push(store.directoryEnv); }
    if (store.fallbackDirectoryEnvs !== undefined) { names.push(...store.fallbackDirectoryEnvs); }
  }
  return names;
}

function assertRuntimeCredentials(runtime: Runtime): void {
  const { credentials } = runtime;
  expect(credentials !== undefined && (credentials.scope === "single_account" || credentials.scope === "per_provider"), runtime.id).toBe(true);
  expect(credentials?.management === "native" || credentials?.management === "external", runtime.id).toBe(true);
  const env = credentials?.env ?? [];
  const uniqueEnv = new Set(env.map(variable => variable.name));
  expect(uniqueEnv.size === env.length && env.every(variable => variable.field !== undefined), runtime.id).toBe(true);
  const dirEnvs = storeDirectoryEnvs(runtime);
  expect(dirEnvs.filter(name => uniqueEnv.has(name)), runtime.id).toEqual([]);
  if (credentials?.usageDirectoryEnv !== undefined) {
    expect(runtime.accountUsage !== undefined && dirEnvs.includes(credentials.usageDirectoryEnv), runtime.id).toBe(true);
  }
}

test("every built-in runtime declares complete, disjoint credential metadata", async () => {
  await withAllRuntimes((runtimes) => {
    expect(runtimes.map(r => r.id).toSorted()).toEqual([
      "antigravity", "claude", "codebuddy", "codex", "cursor", "devin", "dsh",
      "factory", "grok", "hermes", "kimi", "opencode", "pi", "pi-durable", "qoder", "qwen",
    ]);
    for (const runtime of runtimes) {
      assertRuntimeCredentials(runtime);
    }
  });
});

test("runtime credential management, scope, interpolation and keychain services match native evidence", async () => {
  await withAllRuntimes((runtimes) => {
    const byId = new Map(runtimes.map(r => [r.id, r]));
    expect(runtimes.filter(r => r.credentials?.management === "external").map(r => r.id).toSorted()).toEqual(["dsh", "pi-durable"]);
    expect(runtimes.filter(r => r.credentials?.scope === "per_provider").map(r => r.id).toSorted()).toEqual(["hermes", "opencode", "pi", "pi-durable", "qwen"]);
    expect(byId.get("pi")?.credentials?.interpolation).toEqual([{ syntax: "$VAR", target: "env" }, { syntax: "!command", target: "shell" }]);
    expect(byId.get("opencode")?.credentials?.interpolation).toEqual([{ syntax: "{env:VAR}", target: "env" }]);
    expect(byId.get("codex")?.credentials?.stores?.find(s => s.kind === "keychain")).toEqual({
      kind: "keychain", directoryEnv: "CODEX_HOME", defaultDirectory: ".codex", service: "Codex Auth",
    });
  });
});

test("runtime sign-in paste kind and usageDirectoryEnv match native evidence", async () => {
  await withAllRuntimes((runtimes) => {
    expect(Object.fromEntries(runtimes.map(r => [r.id, r.credentials?.signInPaste]))).toEqual({
      antigravity: "code_or_url", claude: "code", codebuddy: "none", codex: "none", cursor: "none",
      devin: undefined, dsh: undefined, factory: "none", grok: "none", hermes: undefined, kimi: "none",
      opencode: "code", pi: "code_or_url", "pi-durable": undefined, qoder: "none", qwen: undefined,
    });
    expect(Object.fromEntries(
      runtimes.filter(r => r.credentials?.usageDirectoryEnv !== undefined).map(r => [r.id, r.credentials?.usageDirectoryEnv]),
    )).toEqual({
      claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", factory: "FACTORY_HOME_OVERRIDE", grok: "GROK_HOME", kimi: "KIMI_CODE_HOME",
    });
  });
});

test("Pi credentials cover every provider environment variable referenced by bundled @earendil-works/pi-ai", () => {
  const entryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
  const source = readFileSync(path.join(path.dirname(entryPath), "env-api-keys.js"), "utf8");
  const matches = source.match(/\b(?:[A-Z0-9]+_)+(?:API_KEY|TOKEN|PROJECT|LOCATION|PROFILE|URI|FILE|ID|CREDENTIALS)\b/gu);
  const declared = new Set((piCredentials.env ?? []).map(variable => variable.name));
  const missing = [...new Set(matches)].filter(name => !declared.has(name)).toSorted();
  expect(missing).toEqual([]);
});
