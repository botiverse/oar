import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { runtimeBrandIcon, runtimeBrands, type RuntimeBrand } from "../packages/oar/src/brands.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createPiDurableRuntime, defineRuntime } from "../packages/oar/src/index.js";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";

async function durableFixture() {
  const models = createModels();
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  const durable = createPiDurableRuntime({ harness, models });
  return { harness, durable };
}

function assertAsset(id: string, brand: RuntimeBrand) {
  assert.ok(brand.name.length > 0);
  assert.ok(brand.icon?.startsWith("data:image/svg+xml,") === true);
  const svg = decodeURIComponent(brand.icon.slice("data:image/svg+xml,".length));
  assert.equal(svg, readFileSync(new URL(`../packages/oar/assets/brands/${id}.svg`, import.meta.url), "utf8"));
  assert.match(svg, /<svg\s/u);
  assert.doesNotMatch(svg, /<script|<foreignObject|\son\w+=|(?:href|src)=/iu);
}

test("built-in brands are offline SVGs matching the distributed assets", async () => {
  const { harness, durable } = await durableFixture();
  try {
  for (const [id, brand] of Object.entries(runtimeBrands)) {
    assert.equal((id === durable.id ? durable : allRuntimes.require(id)).brand, brand);
    assertAsset(id, brand);
  }
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});

test("custom runtimes receive a neutral brand and can provide their own", () => {
  assert.deepEqual(defineRuntime({ id: "custom", session: startMockSession }).brand, { name: "custom", icon: null });
  const brand = { name: "My runtime", icon: "data:image/svg+xml,test" };
  assert.equal(defineRuntime({ id: "custom", brand, session: startMockSession }).brand, brand);
});

test("theme selection falls back to the default for missing variants", () => {
  const brand = { name: "Custom", icon: "default", icons: { dark: "on-dark" } };
  assert.equal(runtimeBrandIcon(brand, "dark"), "on-dark");
  assert.equal(runtimeBrandIcon(brand, "light"), "default");
  assert.equal(runtimeBrandIcon({ name: "Bare", icon: null }, "dark"), null);
  assert.equal(runtimeBrandIcon({ name: "Light", icon: null, icons: { light: "on-light" } }, "light"), "on-light");
});

test("theme assets are standalone SVGs for their destination background", () => {
  for (const [id, brand] of Object.entries(runtimeBrands)) {
    for (const theme of ["light", "dark"] as const) {
      const selected = runtimeBrandIcon(brand, theme);
      assert.ok(selected !== null);
      assert.ok(selected.startsWith("data:image/svg+xml,"));
      const variant = decodeURIComponent(selected.slice("data:image/svg+xml,".length));
      const file = id === "claude" || id === "antigravity" ? id : `${id}-on-${theme}`;
      assert.equal(variant, readFileSync(new URL(`../packages/oar/assets/brands/${file}.svg`, import.meta.url), "utf8"));
      assert.doesNotMatch(variant, /currentColor|<script|<foreignObject|\son\w+=|(?:href|src)=/iu);
    }
  }
});
