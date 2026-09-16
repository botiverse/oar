import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { runtimeBrandIcon, runtimeBrands } from "../packages/oar/src/brands.js";
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
      const file = id === "claude" ? id : `${id}-on-${theme}`;
      assert.equal(variant, readFileSync(new URL(`../packages/oar/assets/brands/${file}.svg`, import.meta.url), "utf8"));
      assert.doesNotMatch(variant, /currentColor|<script|<foreignObject|\son\w+=|(?:href|src)=/iu);
    }
  }
});
