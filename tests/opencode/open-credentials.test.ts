import { inspect } from "node:util";
import { expect, test, vi } from "vitest";
import { opencodeSession } from "../../packages/oar/src/runtimes/opencode/session.js";

vi.mock("../../packages/oar/src/shared/executable/run.js", () => ({
  runExecutable: async () => { throw new Error("provider rejected opencode-open-key-sentinel", { cause: { detail: "opencode-open-key-sentinel" } }); },
}));

test("OpenCode preparation before ACP opens uses the session credential rule too", async () => {
  const failure: unknown = await opencodeSession({ kind: "available", via: "executable", command: "not-spawned", version: "1.18.35" }, {
    cwd: process.cwd(), systemPrompt: "replace", env: { API_KEY: "opencode-open-key-sentinel" },
  }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ message: "provider rejected [redacted]", cause: { detail: "[redacted]" } });
  expect(inspect(failure, { depth: null })).not.toContain("opencode-open-key-sentinel");
});
