import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { dshRuntime } from "../../packages/oar/src/index.js";
import { dshCatalogResult } from "../../packages/oar/src/runtimes/dsh/list-models.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";

const dir = mkdtempSync(path.join(tmpdir(), "oar-dsh-list-models-"));
const command = fakeAgentBinary(dir, [path.resolve(import.meta.dirname, "../fixtures/fake-dsh.mjs")]);
afterAll(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

test("listModels answers unauthenticated when the default provider lists no models without failing", async () => {
  const empty = await dshRuntime.listModels(
    { kind: "available", via: "executable", command, version: "0.2.1-rc.5" },
    { cwd: dir, env: { FAKE_DSH_MODE: "empty-models" } },
  );
  expect(empty).toEqual({
    kind: "unauthenticated",
    detail: 'DSH default provider "local" (local/thinks) listed no models; configure credentials for local.',
  });
});

test("dshCatalogResult distinguishes missing default-provider credentials from failures and unconfigured catalogs", () => {
  expect(dshCatalogResult({
    providers: [
      { id: "deepseek-official", name: "DeepSeek", models: [] },
      { id: "deepseek-account", name: "DeepSeek Account", models: [] },
    ],
    default: { provider: "deepseek-official", model: "deepseek-flash" },
  })).toEqual({
    kind: "unauthenticated",
    detail: 'DSH default provider "deepseek-official" (deepseek-official/deepseek-flash) listed no models; configure credentials for deepseek-official.',
  });
  expect(dshCatalogResult({
    providers: [{ id: "deepseek-official", name: "DeepSeek", models: [] }],
    default: { provider: "deepseek-official" },
  })).toEqual({
    kind: "unauthenticated",
    detail: 'DSH default provider "deepseek-official" listed no models; configure credentials for deepseek-official.',
  });
  expect(dshCatalogResult({
    providers: [{ id: "deepseek-official", name: "DeepSeek", failure: "boom" }],
    default: { provider: "deepseek-official", model: "deepseek-flash" },
  })).toEqual({
    kind: "unsupported",
    reason: "DSH could not list any provider's models: deepseek-official: boom",
  });
  expect(dshCatalogResult({
    providers: [{ id: "deepseek-official", name: "DeepSeek", models: [] }],
    default: {},
  })).toEqual({ kind: "ok", models: [] });
  expect(dshCatalogResult({
    providers: [{ id: "deepseek-official", name: "DeepSeek", models: [] }],
    default: { provider: "other", model: "m" },
  })).toEqual({ kind: "ok", models: [] });
  expect(dshCatalogResult({
    providers: [
      { id: "deepseek-official", name: "DeepSeek", models: [] },
      { id: "custom", name: "Custom", models: [{ id: "m1", name: "M1" }] },
    ],
    default: { provider: "deepseek-official", model: "deepseek-flash" },
  })).toEqual({
    kind: "ok",
    models: [{ id: "custom/m1", displayName: "M1", provider: { id: "custom", displayName: "Custom" } }],
  });
});
