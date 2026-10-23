import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { launchClaude } from "../../packages/oar/src/runtimes/claude/launch.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawned = vi.hoisted(() => ({ spawnLineProcess: vi.fn() }));
vi.mock("../../packages/oar/src/shared/executable/index.js", () => spawned);
beforeEach(() => { spawned.spawnLineProcess.mockReset(); });

function fileArgument(args: string[], flag: string): string {
  expect(args).toContain(flag);
  return args[args.indexOf(flag) + 1] ?? "";
}
function expectPrivateFiles(directory: string, files: string[]): void {
  for (const file of files) { expect(path.dirname(file)).toBe(directory); }
  if (process.platform !== "win32") {
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    for (const file of files) { expect(statSync(file).mode & 0o777).toBe(0o600); }
  }
}

test("long multiline prompts use private files and are removed on exit", async () => {
  const child = fakeLineProcess();
  const systemPrompt = "private system\n".repeat(6000);
  const appendSystemPrompt = "private append\r\n".repeat(6000);
  let directory = "";
  spawned.spawnLineProcess.mockImplementation((_command: string, args: string[]) => {
    for (const value of [systemPrompt, appendSystemPrompt, "--system-prompt", "--append-system-prompt"]) { expect(args).not.toContain(value); }
    const system = fileArgument(args, "--system-prompt-file");
    const append = fileArgument(args, "--append-system-prompt-file");
    expect(readFileSync(system, "utf8")).toBe(systemPrompt);
    expect(readFileSync(append, "utf8")).toBe(appendSystemPrompt);
    directory = path.dirname(system);
    expectPrivateFiles(directory, [system, append]);
    return child;
  });
  await launchClaude("claude", "session", { cwd: tmpdir(), systemPrompt, appendSystemPrompt });
  expect(directory).not.toBe("");
  expect(existsSync(directory)).toBe(true);
  child.end(0);
  expect(existsSync(directory)).toBe(false);
});

test.each(["throw", "reject"])("prompt-only directory is cleaned when spawn fails: %s", async (failure) => {
  let file = "";
  const child = fakeLineProcess();
  spawned.spawnLineProcess.mockImplementation((_command: string, args: string[]) => {
    file = fileArgument(args, "--system-prompt-file");
    expect(readFileSync(file, "utf8")).toBe("");
    if (failure === "throw") { throw new Error("spawn failed"); }
    return { ...child, spawned: Promise.reject(new Error("spawn failed")), kill: () => { child.kill(); }, onExit: child.onExit.bind(child) };
  });
  await expect(launchClaude("claude", "session", { cwd: tmpdir(), systemPrompt: "" })).rejects.toThrow("spawn failed");
  expect(file).not.toBe("");
  expect(existsSync(path.dirname(file))).toBe(false);
  if (failure === "reject") { expect(child.killed()).toBe(true); }
});
