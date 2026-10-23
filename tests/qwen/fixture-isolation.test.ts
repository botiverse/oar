import { afterEach, expect, test, vi } from "vitest";
import { qwenRuntime } from "../../packages/oar/src/runtimes/qwen/index.js";
import { scriptedRuntime } from "../../packages/oar/src/testing/index.js";
import { selectBackend, type Backend } from "../../sea-trial/harness/backends.js";

afterEach(() => { vi.restoreAllMocks(); });

async function openAndClose(backend: Backend, resume?: string): Promise<string> {
  const session = await backend.runtime.session({ kind: "available", via: "bundled" }, { cwd: process.cwd(), ...(resume === undefined ? {} : { resume }) });
  await session.dispose();
  return session.id;
}

test("behavior sessions isolate native HOME while resume keeps its original store", async () => {
  const call = vi.spyOn(qwenRuntime, "session").mockImplementation(scriptedRuntime({ turn: () => {} }).session);
  const backend = await selectBackend("qwen-aimock");
  try {
    const first = await openAndClose(backend);
    await openAndClose(backend);
    await openAndClose(backend, first);
    const homes = call.mock.calls.map(([, options]) => options.env?.HOME);
    expect(homes).toEqual([expect.any(String), expect.any(String), homes[0]]);
    expect(homes[1]).not.toBe(homes[0]);
  } finally { await backend.aimock?.stop(); }
});
