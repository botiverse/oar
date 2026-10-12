import { afterEach, expect, test, vi } from "vitest";
import { launchClaude } from "../../packages/oar/src/runtimes/claude/launch.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });

async function argsFor(options: { resume?: string; name?: string }): Promise<unknown> {
  const child = fakeLineProcess();
  spawnLineProcess.mockReturnValue(child);
  await launchClaude("claude", "session", { cwd: "/work", ...options });
  child.kill();
  return spawnLineProcess.mock.calls[0]?.[1];
}

test("a new session is launched with --name", async () => {
  expect(await argsFor({ name: "Raft · Otter" })).toEqual(expect.arrayContaining(["--session-id", "session", "--name", "Raft · Otter"]));
});

// [env] claude 2.1.292: `--name` on a resume replaces the name the session has, which may be the user's.
test.each([{ resume: "existing", name: "Raft · Otter" }, {}])("no --name on a resume or without the option: %j", async (options) => {
  expect(await argsFor(options)).not.toContain("--name");
});
