import { afterEach, expect, test, vi } from "vitest";
import type { SessionOptions } from "../../packages/oar/src/contracts/session.js";
import type { LineProcessOptions } from "../../packages/oar/src/shared/executable/index.js";
import { launchClaude } from "../../packages/oar/src/runtimes/claude/launch.js";
import { CLAUDE_PARENT_SESSION_MARKERS, claudeEnv } from "../../packages/oar/src/runtimes/claude/environment.js";
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

/** Every marker set as a parent Claude Code session would, plus two variables that are configuration. */
function inheritParentSession(): void {
  for (const name of CLAUDE_PARENT_SESSION_MARKERS) { vi.stubEnv(name, `parent-${name}`); }
  vi.stubEnv("TRACEPARENT", "00-trace-span-01");
  vi.stubEnv("AI_AGENT", "other-tool/1.0");
}

/** Launch a session and return the environment its child was spawned with. */
async function launchedEnv(env: SessionOptions["env"]): Promise<NodeJS.ProcessEnv> {
  const launches: LineProcessOptions[] = [];
  spawnLineProcess.mockImplementation((_command: string, _args: readonly string[], options: LineProcessOptions) => {
    launches.push(options);
    return fakeLineProcess();
  });
  const child = await launchClaude("claude", "session", { cwd: "/work", ...(env === undefined ? {} : { env }) });
  child.kill();
  return launches[0]?.env ?? {};
}

test("every inherited parent-session marker is removed; trace context and another tool's AI_AGENT pass; explicit env wins (#309)", async () => {
  inheritParentSession();
  const env = await launchedEnv({ CLAUDE_CODE_SESSION_ID: "host-chosen", CLAUDECODE: "host-tried" });
  const kept = CLAUDE_PARENT_SESSION_MARKERS.filter((name) => env[name] !== undefined);
  expect(kept).toEqual(["CLAUDE_CODE_SESSION_ID"]);
  expect([env.CLAUDE_CODE_SESSION_ID, env.TRACEPARENT, env.AI_AGENT]).toEqual(["host-chosen", "00-trace-span-01", "other-tool/1.0"]);
});

test("claude subcommands get the host environment without parent-session markers", () => {
  inheritParentSession();
  const env = claudeEnv();
  expect(CLAUDE_PARENT_SESSION_MARKERS.filter((name) => env[name] !== undefined)).toEqual([]);
  expect(env.TRACEPARENT).toBe("00-trace-span-01");
  expect(process.env.CLAUDE_CODE_CHILD_SESSION).toBe("parent-CLAUDE_CODE_CHILD_SESSION");
});
