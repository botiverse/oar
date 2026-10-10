import { afterEach, expect, test, vi } from "vitest";
import type { SessionOptions } from "../../packages/oar/src/contracts/session.js";
import type { LineProcessOptions } from "../../packages/oar/src/shared/executable/index.js";
import { launchClaude } from "../../packages/oar/src/runtimes/claude/launch.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); vi.unstubAllEnvs(); });

test.each([
  { env: undefined, expected: undefined },
  { env: { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, expected: "claude-desktop" },
  { env: { CLAUDE_CODE_ENTRYPOINT: null }, expected: undefined },
  { env: { CLAUDE_CODE_ENTRYPOINT: "" }, expected: "" },
] satisfies { env: SessionOptions["env"]; expected: string | undefined }[])("inherited entrypoint is removed, explicit $expected wins", async ({ env, expected }) => {
  vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "claude-vscode");
  vi.stubEnv("CLAUDECODE", "parent-session");
  const launches: LineProcessOptions[] = [];
  spawnLineProcess.mockImplementation((_command: string, _args: readonly string[], options: LineProcessOptions) => {
    launches.push(options);
    return fakeLineProcess();
  });
  const child = await launchClaude("claude", "session", { cwd: "/work", ...(env === undefined ? {} : { env }) });
  const [captured] = launches;
  expect(captured?.env?.CLAUDE_CODE_ENTRYPOINT).toBe(expected);
  expect(captured?.env?.CLAUDECODE).toBeUndefined();
  expect([process.env.CLAUDE_CODE_ENTRYPOINT, process.env.CLAUDECODE]).toEqual(["claude-vscode", "parent-session"]);
  child.kill();
});
