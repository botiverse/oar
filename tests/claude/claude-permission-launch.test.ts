import { afterEach, expect, test, vi } from "vitest";
import { launchClaude } from "../../packages/oar/src/runtimes/claude/launch.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess: spawn }));
afterEach(() => { spawn.mockReset(); });

async function launch(launchArgs?: readonly string[]): Promise<readonly string[]> {
  const launches: (readonly string[])[] = [];
  spawn.mockImplementation((_command: string, args: readonly string[]) => { launches.push(args); return fakeLineProcess(); });
  const child = await launchClaude("claude", "session", { cwd: process.cwd(), ...(launchArgs === undefined ? {} : { launchArgs }) });
  child.kill();
  expect(launches).toHaveLength(1);
  return launches[0] ?? [];
}

test.each(["default", "dontAsk", "acceptEdits", "plan"])("explicit %s mode disables bypass and prevents host permission waits", async (mode) => {
  const args = await launch(["--permission-mode", mode]);
  expect(args).not.toContain("--dangerously-skip-permissions");
  expect(args.slice(args.indexOf("--permission-prompts"), args.indexOf("--permission-prompts") + 2)).toEqual(["--permission-prompts", "none"]);
  expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", mode]);
});

test("equals spelling and an explicit none target preserve native mode selection", async () => {
  const args = await launch(["--permission-mode=plan", "--permission-prompts=none"]);
  expect(args).not.toContain("--dangerously-skip-permissions");
  expect(args).toContain("--permission-mode=plan");
});

test("omitting a mode preserves the default bypass", async () => {
  expect(await launch()).toContain("--dangerously-skip-permissions");
});

test.each([
  ["--permission-prompt-tool", "stdio"], ["--permission-prompt-tool=stdio"],
  ["--permission-prompts", "host"], ["--permission-prompts=host"],
  ["--permission-prompts"], ["--permission-prompts="],
  ["--permission-prompts=none", "--permission-prompts=host"],
  ["--permission-mode"], ["--permission-mode="], ["--permission-mode=unknown"],
  ["--permission-mode=default", "--dangerously-skip-permissions"],
])("invalid permission arguments %j refuse before spawning", async (...launchArgs) => {
  await expect(launchClaude("claude", "session", { cwd: process.cwd(), launchArgs })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "launchArgs" });
  expect(spawn).not.toHaveBeenCalled();
});
