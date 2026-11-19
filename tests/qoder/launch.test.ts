/* oxlint-disable eslint/max-statements -- Launch file ownership and failure cleanup need a single ordered scenario. */
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, expect, test, vi } from "vitest";
import { launchQoder } from "../../packages/oar/src/runtimes/qoder/launch.js";
import assert from "node:assert/strict";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawned = vi.hoisted(() => ({ spawnLineProcess: vi.fn(), readExecutableVersion: vi.fn(async () => "1.1.80") }));
vi.mock("../../packages/oar/src/shared/executable/index.js", () => spawned);
beforeEach(() => { spawned.spawnLineProcess.mockReset(); spawned.readExecutableVersion.mockReset().mockResolvedValue("1.1.80"); });

test.each([
  "--replay-user-messages", "--no-replay-user-messages", "--replay-user-messages=false",
  "--include-partial-messages", "--no-include-partial-messages", "--includePartialMessages",
  "--model", "--model=efficient", "-m", "-mefficient", "--reasoning-effort=high",
  "--system-prompt", "--system-prompt-file=/tmp/x", "--append-system-prompt=x", "--append-system-prompt-file=/tmp/y",
  "-phello", "--permission-mode=plan", "--",
])("refuses an override of protocol, identity, model or prompt flags before spawn: %s", async (flag) => {
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

async function untilGone(directory: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (existsSync(directory)) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${directory} removal`);
    // oxlint-disable-next-line no-await-in-loop -- polling for asynchronous FIFO directory removal.
    await delay(10);
  }
}

test("long multiline prompts use private files and MCP credentials use a one-shot handoff removed before exit", async () => {
  const child = fakeLineProcess();
  const systemPrompt = "private system\n".repeat(6000);
  const appendSystemPrompt = "private append\r\n".repeat(6000);
  let promptDirectory = "";
  let mcpPath = "";
  spawned.spawnLineProcess.mockImplementation((_command: string, args: string[]) => {
    for (const value of [systemPrompt, appendSystemPrompt, "--system-prompt", "--append-system-prompt", "secret-token", "Bearer secret-header"]) { expect(args).not.toContain(value); }
    const system = fileArgument(args, "--system-prompt-file");
    const append = fileArgument(args, "--append-system-prompt-file");
    mcpPath = fileArgument(args, "--mcp-config");
    expect(readFileSync(system, "utf8")).toBe(systemPrompt);
    expect(readFileSync(append, "utf8")).toBe(appendSystemPrompt);
    promptDirectory = path.dirname(system);
    expectPrivateFiles(promptDirectory, [system, append]);
    expect(path.dirname(mcpPath)).not.toBe(promptDirectory);
    if (process.platform !== "win32") {
      expect(statSync(path.dirname(mcpPath)).mode & 0o777).toBe(0o700);
      const entry = lstatSync(mcpPath);
      expect({ fifo: entry.isFIFO(), mode: entry.mode & 0o777 }).toEqual({ fifo: true, mode: 0o600 });
    }
    return child;
  });
  const launched = await launchQoder("qoder", "session", { cwd: tmpdir(), systemPrompt, appendSystemPrompt,
    mcpServers: [
      { name: "fixture", command: "fixture", env: { TOKEN: "secret-token" } },
      { name: "remote", type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer secret-header" } },
    ] });
  expect(promptDirectory).not.toBe("");
  expect(mcpPath).not.toBe("");
  // Calling releaseMcpConfig() before a POSIX FIFO is read must not cut off the feed.
  if (process.platform !== "win32") {
    launched.releaseMcpConfig?.();
  }
  expect(JSON.parse(await readFile(mcpPath, "utf8"))).toEqual({
    mcpServers: {
      fixture: { type: "stdio", command: "fixture", args: [], env: { TOKEN: "secret-token" } },
      remote: { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer secret-header" } },
    },
  });
  if (process.platform === "win32") {
    launched.releaseMcpConfig?.();
    expect(existsSync(path.dirname(mcpPath))).toBe(false);
  } else {
    await untilGone(path.dirname(mcpPath));
  }
  expect(existsSync(promptDirectory)).toBe(true);
  child.end(0);
  expect(existsSync(promptDirectory)).toBe(false);
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

test.each(["1.1.78", "1.1.79", "1.1.80"])("legacy %s keeps the worker and stdio permission arguments with --flag=value session ids", async (version) => {
  const child = fakeLineProcess(); spawned.spawnLineProcess.mockReturnValue(child);
  await launchQoder("qoder", "session", { cwd: tmpdir() }, version);
  const args: unknown = spawned.spawnLineProcess.mock.calls[0]?.[1];
  expect(args).toEqual(expect.arrayContaining(["--print", "--input-format", "stream-json", "--permission-prompt-tool", "stdio", "--session-id=session"]));
  expect(args).not.toContain("--sdk"); child.end(0);

  spawned.spawnLineProcess.mockReset();
  const resumed = fakeLineProcess(); spawned.spawnLineProcess.mockReturnValue(resumed);
  await launchQoder("qoder", "saved", { cwd: tmpdir(), resume: "saved" }, version);
  expect(spawned.spawnLineProcess.mock.calls[0]?.[1]).toContain("--resume=saved");
  resumed.end(0);
});

test("1.1.81 sends private launch files inside open_session, not daemon argv, and removes them on failure", async () => {
  let file = "";
  let mcpFile = "";
  const child = fakeLineProcess((line, process) => {
    const frame = asRecord(parseJson(line)); const request = asRecord(frame?.request); assert.ok(frame); assert.ok(request);
    if (request.type === "daemon.initialize") {
      process.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: frame.request_id,
        response: { daemon_protocol_version: 2, capabilities: ["multi_session_v2", "daemon_queries_v1"] } } })}\n`);
    } else {
      const args = request.worker_args; assert.ok(Array.isArray(args) && args.every((arg): arg is string => typeof arg === "string"));
      file = fileArgument(args, "--system-prompt-file");
      mcpFile = fileArgument(args, "--mcp-config");
      expect(readFileSync(file, "utf8")).toBe("private prompt");
      expectPrivateFiles(path.dirname(file), [file]);
      process.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: frame.request_id, error: "native secret" } })}\n`);
    }
  });
  spawned.spawnLineProcess.mockReturnValue(child);
  await expect(launchQoder("qoder", "session", { cwd: tmpdir(), systemPrompt: "private prompt", mcpServers: [{ name: "fixture", command: "fixture", env: { TOKEN: "daemon-secret" } }] }, "1.1.81")).rejects.toThrow("Qoder refused daemon.open_session");
  expect(spawned.spawnLineProcess.mock.calls[0]?.[1]).toEqual(["--sdk"]);
  expect(file).not.toBe(""); expect(mcpFile).not.toBe("");
  expect(existsSync(path.dirname(file))).toBe(false);
  expect(existsSync(path.dirname(mcpFile))).toBe(false);
  expect(child.killed()).toBe(true);
});

test("an unknown version fails before spawning any control or permission transport", async () => {
  await expect(launchQoder("qoder", "session", { cwd: tmpdir() }, "unknown")).rejects.toThrow("version compatibility");
  expect(spawned.spawnLineProcess).not.toHaveBeenCalled();
});

test.each(["1.1.81", "1.1.82", "1.1.83"])("an omitted installation version probes %s once and carries it with the selected daemon", async (version) => {
  spawned.readExecutableVersion.mockResolvedValue(version);
  const child = fakeLineProcess((line, process) => {
    const frame = asRecord(parseJson(line)); const request = asRecord(frame?.request);
    const initialized = request?.type === "daemon.initialize";
    process.emit(`${JSON.stringify({ type: "control_response", ...(initialized ? {} : { session_id: "session" }), response: {
      subtype: "success", request_id: frame?.request_id,
      response: initialized ? { daemon_protocol_version: 2, capabilities: ["multi_session_v2", "daemon_queries_v1"] } : {},
    } })}\n`);
  });
  spawned.spawnLineProcess.mockReturnValue(child);
  const process = await launchQoder("qoder", "session", { cwd: tmpdir(), env: { QODER_VERSION_SCOPE: "fixture" } });
  expect(process.qoderVersion).toBe(version);
  expect(spawned.readExecutableVersion).toHaveBeenCalledExactlyOnceWith("qoder", 15_000, undefined, expect.objectContaining({ QODER_VERSION_SCOPE: "fixture" }), undefined);
  expect(spawned.spawnLineProcess.mock.calls[0]?.[1]).toEqual(["--sdk"]);
  child.end(0);
});

test("an unreadable probed version cannot silently use a legacy model path", async () => {
  spawned.readExecutableVersion.mockResolvedValue("unknown");
  await expect(launchQoder("qoder", "session", { cwd: tmpdir() })).rejects.toThrow("version compatibility");
  expect(spawned.spawnLineProcess).not.toHaveBeenCalled();
});
