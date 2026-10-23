import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { launchClaude } from "../../packages/oar/src/runtimes/claude/launch.js";
import type { LineProcessOptions } from "../../packages/oar/src/shared/executable/index.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess: spawn }));
afterEach(() => { spawn.mockReset(); vi.unstubAllEnvs(); });

// oxlint-disable-next-line eslint/max-statements -- assert one launch and its parent/child environment together.
test("exclude keeps the credential directory, overrides memory controls only in the child, and covers custom ancestor paths", async () => {
  const home = path.resolve("test-user");
  const config = path.join(home, "custom-claude");
  vi.stubEnv("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "0");
  const launches: { args: readonly string[]; options: LineProcessOptions }[] = [];
  spawn.mockImplementation((_command: string, args: readonly string[], options: LineProcessOptions) => { launches.push({ args, options }); return fakeLineProcess(); });
  const child = await launchClaude("claude", "id", {
    cwd: path.join(home, "project"), userConfiguration: "exclude", serviceTier: "fast",
    env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0", ENABLE_CLAUDEAI_MCP_SERVERS: "true" },
  });
  child.kill();
  const [launch] = launches;
  expect(launch?.options.env).toMatchObject({ CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
  expect(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("0");
  const args = launch?.args ?? [];
  expect(args.filter((arg) => arg === "--settings")).toHaveLength(1);
  expect(args).toEqual(expect.arrayContaining(["--setting-sources", "project,local", "--strict-mcp-config"]));
  const settings: unknown = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}");
  expect(settings).toEqual({ fastMode: true, claudeMdExcludes: [path.join(home, ".claude", "**"), path.join(config, "**"), path.join(home, "CLAUDE.md"), path.join(home, "CLAUDE.local.md")].map((file) => process.platform === "win32" ? file.replaceAll("\\", "/") : file) });
});

test.each(["--settings", "--settings={}", "--setting-sources=user", "--strict-mcp-config"])("exclude refuses conflicting %s before process launch", async (flag) => {
  await expect(launchClaude("claude", "id", { cwd: process.cwd(), userConfiguration: "exclude", launchArgs: [flag] })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "launchArgs" });
  expect(spawn).not.toHaveBeenCalled();
});

test.each([undefined, "include"] as const)("%s leaves native settings and credential location untouched", async (userConfiguration) => {
  const launches: { args: readonly string[]; options: LineProcessOptions }[] = [];
  spawn.mockImplementation((_command: string, args: readonly string[], options: LineProcessOptions) => { launches.push({ args, options }); return fakeLineProcess(); });
  const child = await launchClaude("claude", "id", { cwd: process.cwd(), ...(userConfiguration === undefined ? {} : { userConfiguration }), env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" } });
  child.kill();
  expect(launches[0]?.args).not.toContain("--setting-sources");
  expect(launches[0]?.args).not.toContain("--strict-mcp-config");
  expect(launches[0]?.options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("0");
});
