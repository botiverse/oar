import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { cursorNativeEnvironment } from "../../packages/oar/src/index.js";

vi.mock("node:module", async (original) => {
  const actual = await original<{ createRequire: typeof createRequire }>();
  return { ...actual, createRequire: vi.fn(actual.createRequire) };
});
afterEach(() => { vi.unstubAllEnvs(); });

test.each([undefined, "host-owned-path"])("native package discovery returns usable paths without changing host environment (%s)", (value) => {
  vi.stubEnv("CURSOR_TREE_SITTER_VENDOR_DIR", value);
  vi.stubEnv("CURSOR_RIPGREP_PATH", value);
  const found = cursorNativeEnvironment();
  expect(found).not.toBeNull();
  for (const file of Object.values(found ?? {})) {
    expect(path.isAbsolute(file)).toBe(true);
    expect(existsSync(file)).toBe(true);
  }
  expect(process.env.CURSOR_TREE_SITTER_VENDOR_DIR).toBe(value);
  expect(process.env.CURSOR_RIPGREP_PATH).toBe(value);
});

test("unresolvable native packages return null without changing the environment", () => {
  vi.stubEnv("CURSOR_TREE_SITTER_VENDOR_DIR", "host-owned-path");
  vi.mocked(createRequire).mockImplementationOnce(() => { throw new Error("native package unavailable"); });
  expect(cursorNativeEnvironment()).toBeNull();
  expect(process.env.CURSOR_TREE_SITTER_VENDOR_DIR).toBe("host-owned-path");
});
