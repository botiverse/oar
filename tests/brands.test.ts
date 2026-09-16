import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { runtimeBrands } from "../packages/oar/src/brands.js";
import { defineRuntime, runtimes } from "../packages/oar/src/index.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";

test("built-in brands are offline SVGs matching the distributed assets", () => {
  for (const [id, brand] of Object.entries(runtimeBrands)) {
    assert.equal(runtimes.require(id).brand, brand);
    assert.ok(brand.name.length > 0);
    assert.ok(brand.icon.startsWith("data:image/svg+xml,"));
    const svg = decodeURIComponent(brand.icon.slice("data:image/svg+xml,".length));
    assert.equal(svg, readFileSync(new URL(`../packages/oar/assets/brands/${id}.svg`, import.meta.url), "utf8"));
    assert.match(svg, /<svg\s/u);
    assert.doesNotMatch(svg, /<script|<foreignObject|\son\w+=|(?:href|src)=/iu);
  }
});

test("custom runtimes receive a neutral brand and can provide their own", () => {
  assert.deepEqual(defineRuntime({ id: "custom", session: startMockSession }).brand, { name: "custom", icon: null });
  const brand = { name: "My runtime", icon: "data:image/svg+xml,test" };
  assert.equal(defineRuntime({ id: "custom", brand, session: startMockSession }).brand, brand);
});
