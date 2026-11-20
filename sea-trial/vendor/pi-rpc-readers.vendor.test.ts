import { piRpcTestOptions } from "../harness/pi-rpc.js";
/* oxlint-disable import/max-dependencies -- Native reader isolation, fixture files and process cleanup evidence. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createPiRuntime, type SessionOptions } from "../../packages/oar/src/index.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { killGraceMs } from "../../packages/oar/src/shared/executable/index.js";
import { processStart } from "../../tests/fixtures/process-start.js";
import { eventually } from "../../tests/fixtures/process-tree.js";

const identityModule = new URL("../../tests/fixtures/process-start.ts", import.meta.url).href;
const installed = { kind: "available", via: "bundled" } as const;
afterEach(() => { vi.unstubAllEnvs(); });

function children(file: string): { pid: number; start: string; noSession: boolean; directory: string | undefined }[] {
  return readFileSync(file, "utf8").trim().split("\n").map((line) => {
    const row = asRecord(parseJson(line));
    assert.ok(row !== null && typeof row.pid === "number" && typeof row.start === "string");
    assert.ok(row.directory === undefined || typeof row.directory === "string");
    return { pid: row.pid, start: row.start, noSession: row.noSession === true, directory: row.directory };
  });
}

async function expectExited(child: { pid: number; start: string }, withinMs: number): Promise<void> {
  const exited = await eventually(() => processStart(child.pid) !== child.start, withinMs);
  expect(exited, `Pi reader ${String(child.pid)} started at ${child.start} is still present`).toBe(true);
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "oar-pi-readers-"));
  const cwd = path.join(root, "project"), home = path.join(root, "child-home");
  const agentDir = path.join(home, ".pi", "agent"), hostDir = path.join(root, "host-agent");
  await Promise.all([cwd, hostDir, path.join(agentDir, "extensions"), path.join(agentDir, "prompts"), path.join(agentDir, "skills", "reader")].map(async (dir) => mkdir(dir, { recursive: true })));
  const capture = path.join(root, "children.jsonl");
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
    "reader-fixture": { api: "anthropic-messages", baseUrl: "http://127.0.0.1:1", apiKey: "OAR_READER_FIXTURE_KEY", models: [{
      id: "child-model", name: "Child model", reasoning: false, input: ["text"], contextWindow: 10_000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }] },
  } }));
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "reader-fixture", defaultModel: "child-model" }));
  await writeFile(path.join(agentDir, "prompts", "child-prompt.md"), "---\ndescription: Child prompt\nargument-hint: <file>\n---\nPRIVATE TEMPLATE BODY\n");
  await writeFile(path.join(agentDir, "skills", "reader", "SKILL.md"), "---\nname: reader\ndescription: Reader skill\nuser-invocable: false\ndisable-model-invocation: true\n---\nPRIVATE SKILL BODY\n");
  await mkdir(path.join(agentDir, "skills", "broken"));
  await writeFile(path.join(agentDir, "skills", "broken", "SKILL.md"), "---\nname: [invalid\n---\nPRIVATE BROKEN SKILL\n");
  await writeFile(path.join(agentDir, "extensions", "reader.ts"), `import { appendFileSync } from "node:fs";
import { currentProcessStart } from ${JSON.stringify(identityModule)};
export default function(pi) {
  pi.registerCommand(process.env.OAR_READER_COMMAND, { description: "Environment command", handler: async () => {} });
  pi.on("session_start", () => appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ pid: process.pid, start: currentProcessStart(),
    noSession: process.argv.includes("--no-session"), directory: process.env.OAR_PI_RPC_DIRECTORY }) + "\\n"));
}`);
  vi.stubEnv("OAR_PI_AGENT_DIR", hostDir);
  const env: NonNullable<SessionOptions["env"]> = { HOME: home, OAR_PI_AGENT_DIR: null, PI_CODING_AGENT_DIR: null,
    PI_PACKAGE_DIR: null, PI_OFFLINE: "1", OAR_READER_COMMAND: "child-command", OAR_READER_FIXTURE_KEY: "fake-reader-fixture-key" };
  return { root, cwd, agentDir, hostDir, capture, env,
    async stop() { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  };
}

describe.skipIf(process.env.OAR_TEST !== "pi-rpc-aimock")("native Pi RPC readers", () => {
  test.each([false, true])("models and commands use the child HOME and full env; explicit host command=%s", async (selectedCommand) => {
    const f = await fixture();
    const runtime = createPiRuntime({ ...piRpcTestOptions(), ...(selectedCommand ? {
      command: process.execPath, args: [fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"))],
    } : {}) });
    const options = { cwd: f.cwd, env: f.env, timeoutMs: 30_000 };
    try {
      const models = await runtime.listModels(installed, options);
      assert.ok(models.kind === "ok");
      expect(models.models).toContainEqual({ id: "reader-fixture/child-model", displayName: "Child model", provider: { id: "reader-fixture" } });
      const commands = await runtime.commands(installed, options);
      assert.ok(commands.kind === "ok");
      expect(commands.partial).toBe(false);
      expect(commands.items).toContainEqual({ name: "child-command", description: "Environment command", source: "extension" });
      expect(commands.items).toContainEqual({ name: "child-prompt", description: "Child prompt", source: "prompt" });
      const skills = await runtime.skills(installed, options);
      assert.ok(skills.kind === "ok");
      expect(skills.partial).toBe(false);
      expect(skills.items).toEqual([{ name: "reader", userInvocable: true, description: "Reader skill", source: "auto", scope: "user", path: path.join(f.agentDir, "skills", "reader", "SKILL.md") }]);
      expect(commands.items.find((command) => command.name === "child-prompt")).not.toHaveProperty("argumentHint");
      expect(JSON.stringify([models, commands, skills])).not.toContain("PRIVATE");
      expect(process.env.OAR_PI_AGENT_DIR).toBe(f.hostDir);
      expect(await readdir(f.hostDir)).toEqual([]);
      expect(existsSync(path.join(f.agentDir, "sessions"))).toBe(false);
      const processes = children(f.capture);
      expect(processes).toHaveLength(3);
      for (const child of processes) {
        expect(child.noSession).toBe(true);
        // oxlint-disable-next-line no-await-in-loop -- Each native read has its own process lifecycle.
        await expectExited(child, 5000);
        assert.ok(child.directory !== undefined);
        expect(existsSync(child.directory)).toBe(false);
      }
    } finally { await f.stop(); }
  }, 120_000);

  test.each([{ stage: "version", reader: "commands" }, { stage: "query", reader: "commands" }, { stage: "query", reader: "models" }])("$reader deadline kills a stalled $stage process and removes any private directory", async ({ stage, reader }) => {
    const f = await fixture();
    const pidFile = path.join(f.root, "stalled.json"), script = path.join(f.root, "stalled-pi.mjs");
    const { PI_AI_VERSION } = await import("@earendil-works/pi-ai");
    await writeFile(script, `import { writeFileSync } from "node:fs";
import { currentProcessStart } from ${JSON.stringify(identityModule)};
if (process.argv.includes("--version") && ${JSON.stringify(stage)} !== "version") { console.log(${JSON.stringify(PI_AI_VERSION)}); }
else { writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid, start: currentProcessStart(), directory: process.env.OAR_PI_RPC_DIRECTORY })); setInterval(() => {}, 1000); }`);
    const runtime = createPiRuntime({ execution: "subprocess", command: process.execPath, args: ["--import", import.meta.resolve("tsx"), script] });
    try {
      const options = { cwd: f.cwd, env: f.env, timeoutMs: 8000 };
      if (reader === "models") {
        await expect(runtime.listModels(installed, options)).rejects.toThrow("Pi RPC model listing timed out");
      } else {
        const result = await runtime.commands(installed, options);
        expect(result).toMatchObject({ kind: "unavailable", code: "timeout" });
      }
      const child = children(pidFile)[0];
      assert.ok(child !== undefined);
      // Timeout begins the same bounded native shutdown as a session dispose.
      await expectExited(child, killGraceMs() + 2000);
      const directory = child.directory;
      if (stage === "query") { expect(directory).toBeTypeOf("string"); }
      if (directory !== undefined) { expect(await eventually(() => !existsSync(directory), 5000)).toBe(true); }
    } finally { await f.stop(); }
  }, 30_000);

  test("a failed native command cannot become a successful empty catalog", async () => {
    vi.stubEnv("OAR_PI_READER_CHANGED", "host");
    const runtime = createPiRuntime({ execution: "subprocess", command: "oar-missing-pi-reader-command" });
    const options = { env: { OAR_PI_READER_CHANGED: "child" }, timeoutMs: 10_000 };
    const result = await runtime.commands(installed, options);
    assert.equal(result.kind, "unavailable");
    expect(result).toMatchObject({ code: "query_failed", reason: "Native inventory query failed" });
    await expect(runtime.listModels(installed, options)).rejects.toThrow("Pi RPC could not list available models");
  });
});
