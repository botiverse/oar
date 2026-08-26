import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createPiModelCatalog } from "../packages/oar/src/providers/pi/catalog.js";

// Exercises the real Pi model catalog (built-in providers load without network
// or credentials), asserting the provider-independent shape we expose.
const catalogDir = mkdtempSync(join(tmpdir(), "oar-catalog-"));
const authPath = join(catalogDir, "auth.json");

test("pi catalog lists providers with usable-auth status", async () => {
  const catalog = await createPiModelCatalog({ authPath, modelsPath: null });
  const providers = catalog.providers();
  expect(providers.length).toBeGreaterThan(0);
  const anthropic = providers.find((provider) => provider.id === "anthropic");
  expect(anthropic).toMatchObject({ id: "anthropic", configured: false });
  expect(typeof anthropic?.name).toBe("string");
});

test("pi catalog normalizes models and scopes by provider", async () => {
  const catalog = await createPiModelCatalog({ authPath, modelsPath: null });
  const models = catalog.models("anthropic");
  expect(models.length).toBeGreaterThan(0);
  const offSpec = models.filter((model) => model.providerId !== "anthropic"
    || model.wire !== "anthropic-messages" || model.contextWindow <= 0 || !model.input.includes("text"));
  expect(offSpec).toEqual([]);
  expect(catalog.models().length).toBeGreaterThanOrEqual(models.length);
  const fallback = catalog.defaultModel("anthropic");
  expect(models.some((model) => model.id === fallback)).toBe(true);
});
