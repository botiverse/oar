/* oxlint-disable eslint/max-statements -- Launch file ownership and failure cleanup need a single ordered scenario. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { launchQoder } from "../../packages/oar/src/runtimes/qoder/launch.js";
import assert from "node:assert/strict";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawned = vi.hoisted(() => ({ spawnLineProcess: vi.fn(), readExecutableVersion: vi.fn(async () => "1.1.80") }));
vi.mock("../../packages/oar/src/shared/executable/index.js", () => spawned);
beforeEach(() => { spawned.spawnLineProcess.mockReset(); });

test.each(["--replay-user-messages", "--no-replay-user-messages", "--replay-user-messages=false"])("refuses an override of native input identity before spawn: %s", async (flag) => {
  await expect(launchQoder("qoder", "session", { cwd: tmpdir(), launchArgs: [flag] })).rejects.toMatchObject({
    name: "UnsupportedOptionError", option: "launchArgs",
  });
  expect(spawned.spawnLineProcess).not.toHaveBeenCalled();
});

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

test("long multiline prompts use private files beside MCP config and are removed on exit", async () => {
  const child = fakeLineProcess();
  const systemPrompt = "private system\n".repeat(6000);
  const appendSystemPrompt = "private append\r\n".repeat(6000);
  let directory = "";
  spawned.spawnLineProcess.mockImplementation((_command: string, args: string[]) => {
    for (const value of [systemPrompt, appendSystemPrompt, "--system-prompt", "--append-system-prompt"]) { expect(args).not.toContain(value); }
    const system = fileArgument(args, "--system-prompt-file");
    const append = fileArgument(args, "--append-system-prompt-file");
    const mcp = fileArgument(args, "--mcp-config");
    expect(readFileSync(system, "utf8")).toBe(systemPrompt);
    expect(readFileSync(append, "utf8")).toBe(appendSystemPrompt);
    directory = path.dirname(system);
    expectPrivateFiles(directory, [system, append, mcp]);
    return child;
  });
  await launchQoder("qoder", "session", { cwd: tmpdir(), systemPrompt, appendSystemPrompt,
    mcpServers: [{ name: "fixture", command: "fixture" }] });
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
  await expect(launchQoder("qoder", "session", { cwd: tmpdir(), systemPrompt: "" })).rejects.toThrow("spawn failed");
  expect(file).not.toBe("");
  expect(existsSync(path.dirname(file))).toBe(false);
  if (failure === "reject") { expect(child.killed()).toBe(true); }
});

test.each(["1.1.78", "1.1.79", "1.1.80"])("legacy %s keeps the worker and stdio permission arguments", async (version) => {
  const child = fakeLineProcess(); spawned.spawnLineProcess.mockReturnValue(child);
  await launchQoder("qoder", "session", { cwd: tmpdir() }, version);
  const args: unknown = spawned.spawnLineProcess.mock.calls[0]?.[1];
  expect(args).toEqual(expect.arrayContaining(["--print", "--input-format", "stream-json", "--permission-prompt-tool", "stdio"]));
  expect(args).not.toContain("--sdk"); child.end(0);
});

test("1.1.81 sends private launch files inside open_session, not daemon argv, and removes them on failure", async () => {
  let file = "";
  const child = fakeLineProcess((line, process) => {
    const frame = asRecord(parseJson(line)); const request = asRecord(frame?.request); assert.ok(frame); assert.ok(request);
    if (request.type === "daemon.initialize") {
      process.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: frame.request_id,
        response: { daemon_protocol_version: 2, capabilities: ["multi_session_v2", "daemon_queries_v1"] } } })}\n`);
    } else {
      const args = request.worker_args; assert.ok(Array.isArray(args) && args.every((arg): arg is string => typeof arg === "string"));
      file = fileArgument(args, "--system-prompt-file");
      expect(readFileSync(file, "utf8")).toBe("private prompt");
      expectPrivateFiles(path.dirname(file), [file]);
      process.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: frame.request_id, error: "native secret" } })}\n`);
    }
  });
  spawned.spawnLineProcess.mockReturnValue(child);
  await expect(launchQoder("qoder", "session", { cwd: tmpdir(), systemPrompt: "private prompt" }, "1.1.81")).rejects.toThrow("Qoder refused daemon.open_session");
  expect(spawned.spawnLineProcess.mock.calls[0]?.[1]).toEqual(["--sdk"]);
  expect(file).not.toBe(""); expect(existsSync(path.dirname(file))).toBe(false); expect(child.killed()).toBe(true);
});

test("an unknown version fails before spawning any control or permission transport", async () => {
  await expect(launchQoder("qoder", "session", { cwd: tmpdir() }, "unknown")).rejects.toThrow("version compatibility");
  expect(spawned.spawnLineProcess).not.toHaveBeenCalled();
});
