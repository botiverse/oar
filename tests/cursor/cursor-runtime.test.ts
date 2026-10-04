import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { createCursorRuntime, runtimes, type CursorSdk } from "../../packages/oar/src/index.js";

const bundled = { kind: "available", via: "bundled" } as const;

const unused = (): never => assert.fail("only the model catalog is read");

function catalogOnly(): CursorSdk {
  return {
    Agent: { create: unused, resume: unused, listRuns: unused },
    Cursor: { models: { list: async () => [{ id: "composer-2.5", displayName: "Composer 2.5" }] } },
  };
}

test("cursor is not built in: the host hands over its SDK", () => {
  assert.equal(runtimes.get("cursor"), undefined);
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
