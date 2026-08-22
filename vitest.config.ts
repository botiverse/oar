import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/*.test.ts", "sea-trial/vendor/*.test.ts"],
    update: process.env.CI === undefined ? "all" : "none",
  },
});
