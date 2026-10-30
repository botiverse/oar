import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import { createCursorRuntime, defaultRuntimes, type CursorSdk } from "../../packages/oar/src/index.js";
import { openFakeCursor } from "../fixtures/fake-cursor-sdk.js";

const bundled = { kind: "available", via: "bundled" } as const;
afterEach(() => { vi.unstubAllEnvs(); });

test("Cursor execution agrees with the session opened through the public runtime", async () => {
  const { runtime, session } = await openFakeCursor();
  expect(runtime.execution).toBe("in_process");
  expect(session.placement).toBe(runtime.execution);
  await session.dispose();
});

const unused = (): never => assert.fail("only the model catalog is read");

function catalogOnly(): CursorSdk {
  return {
    Agent: { create: unused, resume: unused, listRuns: unused },
    Cursor: { models: { list: async () => [{ id: "composer-2.5", displayName: "Composer 2.5" }] } },
  };
}

test.each([undefined, "host-owned-path"])("loading the SDK preserves the host's native package environment (%s)", async (value) => {
  vi.stubEnv("CURSOR_TREE_SITTER_VENDOR_DIR", value);
  vi.stubEnv("CURSOR_RIPGREP_PATH", value);
  const runtime = createCursorRuntime({ sdk: async () => catalogOnly() });
  const catalog = await runtime.listModels(bundled);
  expect(catalog.kind).toBe("ok");
  expect(process.env.CURSOR_TREE_SITTER_VENDOR_DIR).toBe(value);
  expect(process.env.CURSOR_RIPGREP_PATH).toBe(value);
});

test("cursor is not built in: the host hands over its SDK", () => {
  assert.equal(defaultRuntimes.get("cursor"), undefined);
  assert.equal(createCursorRuntime({ sdk: async () => catalogOnly() }).id, "cursor");
});

test("the host's SDK loads once, on the first call that needs it", async () => {
  let loads = 0;
  const runtime = createCursorRuntime({
    sdk: async () => {
      loads += 1;
      return catalogOnly();
    },
  });
  assert.deepEqual(await runtime.installation(), bundled);
  assert.equal(loads, 0);
  const first = await runtime.listModels(bundled);
  const second = await runtime.listModels(bundled);
  assert.deepEqual([first.kind, second.kind, loads], ["ok", "ok", 1]);
});

test("a failed load says so and is retried by the next call", async () => {
  let loads = 0;
  const runtime = createCursorRuntime({
    sdk: async () => {
      loads += 1;
      throw new Error("Cannot find package '@cursor/sdk'");
    },
  });
  await expect(runtime.session(bundled, { cwd: "/w" })).rejects.toThrow("cursor could not load @cursor/sdk through the host's sdk loader");
  await expect(runtime.session(bundled, { cwd: "/w" })).rejects.toMatchObject({ cause: { message: "Cannot find package '@cursor/sdk'" } });
  assert.equal(loads, 2);
});

test("a loader that throws before returning a promise is retried too", async () => {
  let loads = 0;
  const runtime = createCursorRuntime({
    sdk: () => {
      loads += 1;
      throw new Error("cursor is switched off");
    },
  });
  await expect(runtime.session(bundled, { cwd: "/w" })).rejects.toThrow("cursor could not load @cursor/sdk through the host's sdk loader");
  await expect(runtime.session(bundled, { cwd: "/w" })).rejects.toThrow("cursor could not load @cursor/sdk through the host's sdk loader");
  assert.equal(loads, 2);
});
