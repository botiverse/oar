import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { launchClaude } from "../packages/oar/src/runtimes/claude/launch.js";
import { codexThreadOpen } from "../packages/oar/src/runtimes/codex/open.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => never>());
vi.mock("../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });

const cases = ["systemPrompt", "appendSystemPrompt"].flatMap((option) => ["", "same prompt on every open", "changed prompt"].map((value) => ({ option, value })));

test.each(cases)("Claude forwards resumed $option=$value through its native prompt file", async ({ option, value }) => {
  const launched = new Error("stop after inspecting argv");
  spawnLineProcess.mockImplementation((_command, args) => {
    expect(args).toEqual(expect.arrayContaining(["--resume", "saved-session"]));
    const flag = option === "systemPrompt" ? "--system-prompt-file" : "--append-system-prompt-file";
    const file = args[args.indexOf(flag) + 1];
    expect(file).toBeDefined();
    expect(readFileSync(file ?? "", "utf8")).toBe(value);
    throw launched;
  });
  await expect(launchClaude("claude", "saved-session", { cwd: process.cwd(), resume: "saved-session", [option]: value })).rejects.toBe(launched);
  expect(spawnLineProcess).toHaveBeenCalledOnce();
});

test.each(cases)("Codex forwards resumed $option=$value unchanged", ({ option, value }) => {
  const request = codexThreadOpen({ cwd: process.cwd(), resume: "saved-thread", [option]: value });
  expect(request.method).toBe("thread/resume");
  expect(request.params).toHaveProperty(option === "systemPrompt" ? "baseInstructions" : "developerInstructions", value);
});
