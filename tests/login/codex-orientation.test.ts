import { expect, test, vi } from "vitest";
import { defineRuntime, orient, RuntimeRegistry } from "../../packages/oar/src/index.js";
import { codexAuthStatus } from "../../packages/oar/src/runtimes/codex/login.js";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";

vi.mock("../../packages/oar/src/shared/executable/index.js", async (original) => ({
  ...await original<object>(),
  runExecutable: vi.fn(async () => ({ ok: true, stdout: "", stderr: "Logged in using ChatGPT", exitCode: 0 })),
}));

test("Codex orientation does not start login status until account depth", async () => {
  const registry = new RuntimeRegistry([defineRuntime({
    id: "codex",
    installation: async () => ({ kind: "available", via: "executable", command: "codex-fixture" }),
    authStatus: codexAuthStatus,
    session: async () => { throw new Error("orientation must not open a session"); },
  })]);
  const local = await orient(registry);
  expect(local.runtimes[0]?.auth).toEqual({ kind: "skipped", because: "depth" });
  expect(runExecutable).not.toHaveBeenCalled();

  const account = await orient(registry, { depth: "account" });
  expect(runExecutable).toHaveBeenCalledExactlyOnceWith("codex-fixture", ["login", "status"], expect.anything());
  expect(account.runtimes[0]?.auth).toMatchObject({ kind: "ok", value: { kind: "logged_in", source: "codex login status" } });
});
