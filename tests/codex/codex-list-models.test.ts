import { afterEach, expect, test, vi } from "vitest";
import { codexListModels } from "../../packages/oar/src/runtimes/codex/list-models.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "codex", version: "0.149.0" } as const;

afterEach(() => {
  spawnLineProcess.mockReset();
});

function scripted(chunks: readonly string[], code: number | null): FakeLineProcess {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  queueMicrotask(() => {
    for (const chunk of chunks) {
      fake.emit(chunk);
    }
    fake.end(code);
  });
  return fake;
}

test("codex lister streams a multi-chunk JSON document and projects it", async () => {
  const payload = JSON.stringify({
    models: [
      { slug: "gpt-5.5", display_name: "GPT 5.5", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
      { slug: "secret", visibility: "hide" },
    ],
  });
  const half = Math.floor(payload.length / 2);
  scripted([payload.slice(0, half), `${payload.slice(half)}\n`], 0);
  await expect(codexListModels(installation)).resolves.toEqual({
    kind: "ok",
    models: [{ id: "gpt-5.5", displayName: "GPT 5.5", effortLevels: ["low"] }],
  });
  expect(spawnLineProcess).toHaveBeenCalledWith("codex", ["debug", "models"], expect.anything());
});

test("codex lister fails on a non-zero exit instead of returning an empty list", async () => {
  scripted(["error: config broken\n"], 1);
  await expect(codexListModels(installation)).rejects.toThrow(/Failed to list Codex models/u);
});

test("codex lister fails on invalid JSON", async () => {
  scripted(["not json\n"], 0);
  await expect(codexListModels(installation)).rejects.toThrow(/invalid JSON/u);
});

test("codex lister kills the process on timeout", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  await expect(codexListModels(installation, { timeoutMs: 20 })).rejects.toThrow(/Failed to list Codex models/u);
  expect(fake.killed()).toBe(true);
});
