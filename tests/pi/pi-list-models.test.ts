import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { piCredentials } from "../../packages/oar/src/runtimes/pi/credential-shape.js";
import { createPiListModels, piListModels } from "../../packages/oar/src/runtimes/pi/list-models.js";

const bundled = { kind: "available", via: "bundled", version: "1" } as const;
const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createPiListModels answers unauthenticated when getAvailable is empty and the native catalog is not", async () => {
  const keyless = createPiListModels(async () => {
    await Promise.resolve();
    return {
      getAvailable: async () => { await Promise.resolve(); return []; },
      getModels: () => [{ id: "claude-sonnet-5", provider: "anthropic" }],
    };
  });
  expect(await keyless(bundled)).toEqual({
    kind: "unauthenticated",
    detail: "No Pi provider has configured credentials; configure a provider API key or sign in via createPiProviderAuth().loginProviders().",
  });

  const withDefault = createPiListModels(async () => {
    await Promise.resolve();
    return {
      getAvailable: async () => { await Promise.resolve(); return []; },
      getModels: () => [{ id: "claude-sonnet-5", provider: "anthropic" }],
      savedDefault: { provider: "anthropic", id: "claude-sonnet-5" },
    };
  });
  expect(await withDefault(bundled)).toEqual({
    kind: "unauthenticated",
    detail: "No Pi provider has configured credentials (default is anthropic/claude-sonnet-5); configure a provider API key or sign in via createPiProviderAuth().loginProviders().",
  });

  const trulyEmpty = createPiListModels(async () => {
    await Promise.resolve();
    return {
      getAvailable: async () => { await Promise.resolve(); return []; },
      getModels: () => [],
    };
  });
  expect(await trulyEmpty(bundled)).toEqual({ kind: "ok", models: [] });
});

function isolateKeylessPiHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-pi-keyless-"));
  tempDirs.push(dir);
  for (const variable of piCredentials.env ?? []) {
    vi.stubEnv(variable.name, undefined);
  }
  for (const [key, value] of [
    ["HOME", dir],
    ["USERPROFILE", dir],
    ["XDG_CONFIG_HOME", path.join(dir, ".config")],
    ["OAR_PI_AGENT_DIR", path.join(dir, "agent")],
    ["PI_CODING_AGENT_DIR", undefined],
    ["PI_PACKAGE_DIR", undefined],
  ] as const) {
    vi.stubEnv(key, value);
  }
  return dir;
}

test("piListModels answers unauthenticated through the real SDK in an isolated keyless home", async () => {
  const dir = isolateKeylessPiHome();
  const result = await piListModels(bundled, { cwd: dir, timeoutMs: 15_000 });
  expect(result).toEqual({
    kind: "unauthenticated",
    detail: "No Pi provider has configured credentials; configure a provider API key or sign in via createPiProviderAuth().loginProviders().",
  });
});
