import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createPiModelCatalog } from "../../packages/oar/src/runtimes/pi/catalog.js";
import type { ModelCatalogFacade } from "../../packages/oar/src/contracts/model-catalog.js";

function configured(catalog: ModelCatalogFacade, providerId: string): boolean | undefined {
  return catalog.providers().find((provider) => provider.id === providerId)?.configured;
}

// #291: a key stored in auth.json makes its provider configured at once, before any refresh, and a refresh re-reads the file.
test("pi catalog counts a stored credential as configured before and after a refresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oar-catalog-stored-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "test-key" } }));
  const catalog = await createPiModelCatalog({ authPath, modelsPath: null });
  expect([configured(catalog, "deepseek"), configured(catalog, "anthropic")]).toEqual([true, false]);
  await catalog.refresh({ allowNetwork: false });
  expect(configured(catalog, "deepseek")).toBe(true);
  writeFileSync(authPath, "{}");
  await catalog.refresh({ allowNetwork: false });
  expect(configured(catalog, "deepseek")).toBe(false);
});
