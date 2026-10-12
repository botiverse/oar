import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { codexListModels } from "../../packages/oar/src/runtimes/codex/list-models.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[], options?: { cwd?: string }) => FakeLineProcess>());
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

// #347 (Lookout, codex 0.162.1): a session with no model runs on the configured one, not the catalog's isDefault.
test("codex lister marks the model codex's configuration sets, read for the host's cwd", async () => {
  const requests: { method: unknown; params: unknown }[] = [];
  spawnLineProcess.mockReturnValue(fakeLineProcess((line, child) => {
    const message = asRecord(parseJson(line));
    if (typeof message?.id !== "number") { return; }
    requests.push({ method: message.method, params: message.params });
    const results: Record<string, unknown> = {
      "model/list": { data: [{ model: "gpt-6.1-sol", isDefault: true }, { model: "gpt-5.5" }], nextCursor: null },
      "config/read": { config: { model: "gpt-5.5" } },
    };
    const result = typeof message.method === "string" ? results[message.method] ?? {} : {};
    child.emit(`${JSON.stringify({ id: message.id, result })}\n`);
  }));
  await expect(codexListModels(installation)).resolves.toEqual({ kind: "ok", models: [{ id: "gpt-6.1-sol" }, { id: "gpt-5.5", default: true }] });
  expect(requests.find((request) => request.method === "config/read")?.params).toEqual({ cwd: process.cwd(), includeLayers: false });
});

// rowrow lists per workspace: a project's .codex/config.toml can set another model.
test("codex lister reads the configuration for the requested directory, from an app-server started like a session's", async () => {
  const requests: { method: unknown; params: unknown }[] = [];
  spawnLineProcess.mockReturnValue(fakeLineProcess((line, child) => {
    const message = asRecord(parseJson(line));
    if (typeof message?.id !== "number") { return; }
    requests.push({ method: message.method, params: message.params });
    const result = message.method === "model/list" ? { data: [{ model: "gpt-5.5" }], nextCursor: null } : {};
    child.emit(`${JSON.stringify({ id: message.id, result })}\n`);
  }));
  await codexListModels(installation, { cwd: "workspace" });
  expect(requests.find((request) => request.method === "config/read")?.params).toEqual({ cwd: path.resolve("workspace"), includeLayers: false });
  expect(spawnLineProcess.mock.calls[0]?.[2]?.cwd).toBe(process.cwd());
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
