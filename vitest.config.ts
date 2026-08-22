import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/*.test.ts"],
    update: process.env.CI === undefined ? "all" : "none",
  },
});
