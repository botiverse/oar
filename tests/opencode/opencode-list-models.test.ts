import { resolve } from "node:path";
import { readerEnvironment, expectReaderEnvironment } from "../fixtures/reader-environment.js";
import { expect, test, vi } from "vitest";
import { opencodeListModels, projectOpencodeModels } from "../../packages/oar/src/runtimes/opencode/list-models.js";
import type { ExecutableRunner } from "../../packages/oar/src/shared/executable/run.js";

// The shape of `opencode models --verbose` (1.18.30, cli/cmd/models.ts): a
// `provider/model` line, then `JSON.stringify(model, null, 2)`. Fields
// trimmed to the ones the projection reads, plus one nested object so a
// closing brace inside the body is not taken for the model's end.
function block(id: string, model: object): string {
  return `${id}\n${JSON.stringify(model, null, 2)}\n`;
}

test("each model keeps its provider/model id, its name, and its variants as effort levels", () => {
  const stdout = [
    block("opencode/big-pickle", { id: "big-pickle", providerID: "opencode", name: "Big Pickle", limit: { context: 200_000 }, variants: {} }),
    block("anthropic/claude-haiku-4-5", {
      id: "claude-haiku-4-5",
      providerID: "anthropic",
      name: "Claude Haiku 4.5 (latest)",
      variants: { high: { thinking: { type: "enabled", budgetTokens: 16_000 } }, max: { thinking: { type: "enabled", budgetTokens: 31_999 } } },
    }),
  ].join("");
  expect(projectOpencodeModels(stdout)).toEqual([
    { id: "opencode/big-pickle", displayName: "Big Pickle", provider: { id: "opencode" } },
    { id: "anthropic/claude-haiku-4-5", displayName: "Claude Haiku 4.5 (latest)", effortLevels: ["high", "max"], provider: { id: "anthropic" } },
  ]);
});

test("the plain listing and stray output yield no entry without a model body", () => {
  expect(projectOpencodeModels("opencode/big-pickle\nopencode/fledge-alpha-free\n")).toEqual([]);
  expect(projectOpencodeModels("Models cache refreshed\n")).toEqual([]);
  expect(projectOpencodeModels("")).toEqual([]);
});

const run = vi.hoisted(() => vi.fn<ExecutableRunner>());
vi.mock("../../packages/oar/src/shared/executable/run.js", () => ({ runExecutable: run }));

test("OpenCode listing and a missing version probe both receive the scoped environment", async () => {

  run.mockResolvedValueOnce({ ok: true, stdout: "2.1.2", stderr: "", exitCode: 0 })
    .mockResolvedValueOnce({ ok: true, stdout: "provider/model", stderr: "", exitCode: 0 });
  const result = await opencodeListModels({ kind: "available", via: "executable", command: "opencode" }, { cwd: resolve("/project"), env: readerEnvironment() });
  expect(result).toEqual({ kind: "ok", models: [{ id: "provider/model" }] });
  expect(run.mock.calls.map((call) => call[1])).toEqual([["--version"], ["models", "--standalone"]]);
  for (const call of run.mock.calls) {
    expectReaderEnvironment(call[2]?.env);
    expect(call[2]?.cwd).toBe(resolve("/project"));
  }
});
