import { afterEach, expect, test, vi } from "vitest";
import { codexListModels } from "../../packages/oar/src/runtimes/codex/list-models.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "codex", version: "0.161.0" } as const;

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

function splitReplies(payload: Record<string, unknown>): FakeLineProcess {
  return fakeLineProcess((line, child) => {
    const message = asRecord(parseJson(line));
    if (typeof message?.id !== "number") { return; }
    const reply = JSON.stringify({ id: message.id, result: message.method === "initialize" ? {} : payload });
    const half = Math.floor(reply.length / 2);
    child.emit(reply.slice(0, half));
    child.emit(`${reply.slice(half)}\n`);
  });
}

test("codex lister streams multi-chunk RPC replies and projects the model picker", async () => {
  spawnLineProcess.mockReturnValue(splitReplies({
    data: [
      { model: "gpt-5.5", displayName: "GPT 5.5", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
      { model: "secret", hidden: true },
    ], nextCursor: null,
  }));
  await expect(codexListModels(installation)).resolves.toEqual({
    kind: "ok",
    models: [{ id: "gpt-5.5", displayName: "GPT 5.5", effortLevels: ["low"] }],
  });
  expect(spawnLineProcess).toHaveBeenCalledWith("codex", ["app-server", "--listen", "stdio://"], expect.anything());
});

test("codex lister fails on a non-zero exit instead of returning an empty list", async () => {
  scripted(["error: config broken\n"], 1);
  await expect(codexListModels(installation)).rejects.toThrow(/Failed to list Codex models/u);
});

test("codex lister requires a valid RPC reply even when the process exits cleanly", async () => {
  scripted(["not json\n"], 0);
  await expect(codexListModels(installation)).rejects.toMatchObject({
    message: "Failed to list Codex models", cause: { message: "app-server exited: exit code 0; signal none" },
  });
});

test("codex lister kills the process on timeout", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  await expect(codexListModels(installation, { timeoutMs: 20 })).rejects.toThrow(/Failed to list Codex models/u);
  expect(fake.killed()).toBe(true);
});
