import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { type default as fileSystem, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createPiRuntime, type Session, type SessionOptions } from "../../packages/oar/src/index.js";
import { spawnLineProcess } from "../../packages/oar/src/shared/executable/index.js";
import { startPiAimock } from "../harness/aimock.js";
import { runTurn } from "./support/asserts.js";
import { lastAgentSystem, systemCapture } from "./support/system-prompt.js";

interface ChildObservation { readonly argv: string[]; readonly directory: string }

const unreadable = vi.hoisted(() => ({ name: "", directory: "" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof fileSystem>();
  return { ...fs, writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    await fs.writeFile(...args);
    const file = args[0];
    if (typeof file === "string" && unreadable.name !== "" && path.basename(file) === unreadable.name) {
      unreadable.directory = path.dirname(file);
      await fs.rm(file);
      await fs.mkdir(file); // Reading a directory as UTF-8 fails on all three CI platforms.
    }
  } };
});
vi.mock("../../packages/oar/src/shared/executable/index.js", async (original) => {
  const executable = await original<{ spawnLineProcess: typeof spawnLineProcess }>();
  return { ...executable, spawnLineProcess: vi.fn(executable.spawnLineProcess) };
});

async function fixture(command?: string) {
  const capture = systemCapture();
  const env = await startPiAimock(capture.configure);
  const agentDir = process.env.OAR_PI_AGENT_DIR;
  assert.ok(agentDir !== undefined);
  const cwd = path.join(agentDir, "project");
  await mkdir(cwd);
  await mkdir(path.join(agentDir, "extensions"));
  await writeFile(path.join(agentDir, "extensions", "observe.ts"), `
    import fs from "node:fs";
    export default (pi) => {
      pi.on("session_start", (_event, ctx) => {
        fs.writeFileSync(ctx.cwd + "/child.json", JSON.stringify({ argv: process.argv, directory: process.env.OAR_PI_RPC_DIRECTORY }));
        if (process.env.OAR_PROMPT_PROBE_FAILURE === "open") process.exit(23);
      });
      pi.on("input", () => { if (process.env.OAR_PROMPT_PROBE_FAILURE === "turn") process.exit(23); });
    }
  `);
  const runtime = createPiRuntime({ execution: "subprocess", ...(command === undefined ? {} : { command }) });
  const installation = await runtime.installation();
  assert.ok(installation.kind === "available");
  const sessions: Session[] = [];
  return { env, capture,
    open: async (options: Partial<SessionOptions>) => {
      const session = await runtime.session(installation, { cwd, model: "aimock/aimock-model", ...options, env: { ...env.env, ...options.env } });
      sessions.push(session);
      return session;
    },
    // oxlint-disable-next-line typescript/no-unsafe-return -- Written by this test's native extension before the initial state reply.
    child: (): ChildObservation => JSON.parse(readFileSync(path.join(cwd, "child.json"), "utf8")),
    stop: async () => {
      try { await Promise.all(sessions.map(async (session) => session.dispose())); }
      finally { await env.stop(); }
    },
  };
}

function promptFile(child: ChildObservation, flag: string): string {
  const file = child.argv[child.argv.indexOf(flag) + 1];
  assert.ok(child.argv.includes(flag) && file !== undefined);
  expect(path.dirname(file)).toBe(child.directory);
  expect(existsSync(file)).toBe(true);
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(child.directory).mode & 0o777).toBe(0o700);
  }
  return file;
}

describe.skipIf(process.env.OAR_TEST !== "pi-rpc-aimock")("Pi RPC private prompt files", () => {
  test.each(["bundled", "installed"] as const)("long multiline prompts reach the provider through the %s entry", async (entry) => {
    const command = entry === "installed" ? path.resolve(`node_modules/.bin/pi${process.platform === "win32" ? ".cmd" : ""}`) : undefined;
    const f = await fixture(command);
    const systemPrompt = `OAR_PRIVATE_SYSTEM_START\n${"system line\n".repeat(4000)}OAR_PRIVATE_SYSTEM_END`;
    const appendSystemPrompt = `OAR_PRIVATE_APPEND_START\n${"append line\n".repeat(4000)}OAR_PRIVATE_APPEND_END`;
    try {
      const session = await f.open({ systemPrompt, appendSystemPrompt });
      let directory = "";
      try {
        const child = f.child();
        directory = child.directory;
        expect(child.argv.join(" ")).not.toContain("OAR_PRIVATE_");
        expect(readFileSync(promptFile(child, "--system-prompt"), "utf8")).toBe(systemPrompt);
        expect(readFileSync(promptFile(child, "--append-system-prompt"), "utf8")).toBe(appendSystemPrompt);
        expect(await runTurn(session, "capture the prompt")).toEqual({ kind: "completed" });
        const actual = lastAgentSystem(f.capture.systems);
        expect(actual).toContain(systemPrompt);
        expect(actual).toContain(appendSystemPrompt);
        expect(actual).not.toContain(child.directory);
        expect(actual).not.toContain(path.join(child.directory, "system.txt"));
        expect(actual).not.toContain(path.join(child.directory, "append.txt"));
      } finally { await session.dispose(); }
      expect(existsSync(directory)).toBe(false);
    } finally { await f.stop(); }
  }, 60_000);

  test.each(["system.txt", "append.txt"])("an unreadable %s fails before the session process starts", async (name) => {
    const f = await fixture();
    vi.mocked(spawnLineProcess).mockClear();
    unreadable.name = name;
    unreadable.directory = "";
    try {
      await expect(f.open({ systemPrompt: "system body", appendSystemPrompt: "append body" })).rejects.toThrow(`Pi RPC could not read its private ${name} prompt file`);
      expect(spawnLineProcess).not.toHaveBeenCalled();
      expect(unreadable.directory).not.toBe("");
      expect(existsSync(unreadable.directory)).toBe(false);
      expect(f.capture.systems).toEqual([]);
    } finally { unreadable.name = ""; await f.stop(); }
  }, 60_000);

  test("a native startup failure removes its private prompt files", async () => {
    const f = await fixture();
    try {
      await expect(f.open({ systemPrompt: "startup secret", appendSystemPrompt: "append secret", env: { OAR_PROMPT_PROBE_FAILURE: "open" } })).rejects.toThrow();
      const child = f.child();
      expect(child.argv.join(" ")).not.toContain("secret");
      expect(existsSync(child.directory)).toBe(false);
    } finally { await f.stop(); }
  }, 60_000);

  test("a process exit removes prompts before the host disposes the session", async () => {
    const f = await fixture();
    try {
      const session = await f.open({ systemPrompt: "exit secret", env: { OAR_PROMPT_PROBE_FAILURE: "turn" } });
      try {
        const child = f.child();
        promptFile(child, "--system-prompt");
        await session.prompt("exit");
        await expect.poll(() => existsSync(child.directory)).toBe(false);
      } finally { await session.dispose(); }
    } finally { await f.stop(); }
  }, 60_000);
});
