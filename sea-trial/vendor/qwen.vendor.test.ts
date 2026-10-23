import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, onTestFailed } from "vitest";
import { promptAndWait, qwenRuntime } from "../../packages/oar/src/index.js";
import { readQwenModels } from "../../packages/oar/src/runtimes/qwen/list-models.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startQwenAimock } from "../harness/qwen-aimock.js";
import type { Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { echoServers, echoesReceived, expectedEchoes, leakedCredentials, currentTurnSays, startHttpEcho, STDIO_TOKEN, HTTP_AUTHORIZATION } from "./support/echo-mcp.js";

async function open(env: Awaited<ReturnType<typeof startQwenAimock>>, options: Omit<SessionOptions, "cwd"> = {}): Promise<Session> {
  const installation = await qwenRuntime.installation();
  if (installation.kind !== "available") { throw new Error(`Qwen missing: ${JSON.stringify(installation)}`); }
  return qwenRuntime.session(installation, { ...options, cwd: env.cwd, env: env.env });
}
async function turn(session: Session, input = "hello") {
  const result = await promptAndWait(session, input, { timeoutMs: 45_000 });
  expect(result.kind).toBe("ended");
  if (result.kind !== "ended") { throw new Error(JSON.stringify(result)); }
  return result.outcome;
}
async function persistedCredentials(home: string): Promise<readonly string[]> {
  const files = await readdir(home, { recursive: true, withFileTypes: true });
  const contents = await Promise.all(files.filter((file) => file.isFile()).map(async (file) => readFile(path.join(file.parentPath, file.name), "utf8")));
  return [STDIO_TOKEN, HTTP_AUTHORIZATION].filter((secret) => contents.some((content) => content.includes(secret)));
}
function totals(session: Session) {
  const results = session.records().flatMap((record) => record.kind === "frame" && record.body.type.startsWith("result/") ? [asRecord(record.body.native)] : []);
  return asRecord(results.at(-1)?.usage);
}

describe.skipIf(process.env.OAR_TEST !== "qwen-aimock")("Qwen stream-json 0.26.0", () => {
  test("fresh totals accumulate; restored totals are unknown instead of charging historical work", async () => {
    const env = await startQwenAimock();
    try {
      const first = await open(env);
      const id = first.id;
      let oldInput = 0;
      try {
        expect(first.effort().value).toBeNull();
        expect(await turn(first, "historical_marker")).toEqual({ kind: "completed" });
        oldInput = first.usage().value.total?.input ?? 0;
        expect(oldInput).toBeGreaterThan(0);
        expect(await turn(first, "second marker")).toEqual({ kind: "completed" });
        const raw = totals(first);
        expect(first.usage().value.total).toMatchObject({ input: raw?.input_tokens, output: raw?.output_tokens });
        expect(first.usage().value.total?.input).toBeGreaterThan(oldInput);
        expect(first.model().value).toBe("gpt-5.1");
        expect(first.records().filter((row) => row.kind === "frame" && row.body.type === "command_lifecycle")).toEqual([]);
      } finally { await first.dispose(); }
      const resumed = await open(env, { resume: id });
      try {
        expect(resumed.id).toBe(id);
        expect(await turn(resumed, "after resume")).toEqual({ kind: "completed" });
        expect(totals(resumed)?.input_tokens).toBeGreaterThan(oldInput);
        expect(resumed.usage().value.total).toBeNull();
        expect(JSON.stringify(env.raw.at(-1)?.body)).toContain("historical_marker");
      } finally { await resumed.dispose(); }
    } finally { await env.stop(); }
  }, 90_000);

  test("native catalog and effort readback follow the configured provider without a model request", async () => {
    const env = await startQwenAimock();
    try {
      const installation = await qwenRuntime.installation();
      if (installation.kind !== "available" || installation.via !== "executable") { throw new Error("Qwen missing"); }
      expect(await readQwenModels(installation.command, env.cwd, 15_000, env.env)).toEqual([
        { id: "gpt-5.1", displayName: "Local reasoning model", effortLevels: ["low", "medium", "high"], defaultEffort: "medium" },
      ]);
      expect(env.raw).toEqual([]);
      const session = await open(env, { effort: "high" });
      try {
        expect(session.effort().value).toBe("high");
        expect(await turn(session)).toEqual({ kind: "completed" });
        expect(env.raw.some((request) => asRecord(request.body)?.reasoning_effort === "high")).toBe(true);
      } finally { await session.dispose(); }
      await expect(open(env, { effort: "invalid-oar-effort" })).rejects.toThrow(/invalid-oar-effort/u);
    } finally { await env.stop(); }
  }, 60_000);

  test("stdio and HTTP MCP credentials reach only their servers, including on resume", async () => {
    const env = await startQwenAimock((mock) => {
      // Qwen appends a user reminder after tool results, so match actual result content.
      mock.on({ predicate: currentTurnSays(/call both echo tools/u) }, { toolCalls: [{ id: "stdio", name: "mcp__echo__echo", arguments: '{"text":"stdio-call"}' }] });
      mock.on({ predicate: (request) => { const text = JSON.stringify(request.messages); return text.includes("echo:stdio-call") && !text.includes("echo:http-call"); } },
        { toolCalls: [{ id: "http", name: "mcp__remote__echo", arguments: '{"text":"http-call"}' }] });
      mock.on({ predicate: currentTurnSays(/call the echo tool again/u) }, { toolCalls: [{ id: "resumed", name: "mcp__echo__echo", arguments: '{"text":"resumed-call"}' }] });
      mock.onMessage(/[\s\S]*/u, { content: "auxiliary answer" });
    });
    const http = await startHttpEcho();
    onTestFailed(async () => {
      await mkdir("oar-trial-run/qwen-vendor", { recursive: true });
      await writeFile("oar-trial-run/qwen-vendor/mcp-provider.json", JSON.stringify(env.raw, null, 2));
    });
    try {
      const mcpServers = echoServers(http.url);
      const session = await open(env, { mcpServers });
      const id = session.id;
      try {
        expect(await turn(session, "call both echo tools")).toEqual({ kind: "completed" });
        expect(leakedCredentials(session)).toEqual([]);
        // This reminder exists only in the provider request, not as a host input.
        expect(JSON.stringify(env.raw)).toContain("# Current auto-memory catalog");
        const userFrames = session.records().filter((record) => record.kind === "frame" && record.body.type === "user");
        expect(userFrames.length).toBeGreaterThan(0);
        for (const frame of userFrames) {
          if (frame.kind !== "frame") { throw new Error("Expected a native frame"); }
          expect(frame.body.events.every((event) => event.kind === "tool_call_ended")).toBe(true);
          expect(JSON.stringify(frame.body.native)).not.toContain("# Current auto-memory catalog");
        }
        expect(session.records().flatMap((record) => record.kind === "frame" ? record.body.events : []).filter((event) => event.kind === "user_message")).toEqual([]);
      } finally { await session.dispose(); }
      const resumed = await open(env, { resume: id, mcpServers });
      try {
        expect(await turn(resumed, "call the echo tool again")).toEqual({ kind: "completed" });
        expect(leakedCredentials(resumed)).toEqual([]);
        expect(echoesReceived(env.raw)).toEqual(expectedEchoes());
        expect(await persistedCredentials(env.env.HOME ?? "")).toEqual([]);
      } finally { await resumed.dispose(); }
    } finally { http.stop(); await env.stop(); }
  }, 90_000);

  test("system replacement, append and tool denial reach the native request; schema is refused", async () => {
    const env = await startQwenAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: '{"answer":"ok"}' }); });
    try {
      await expect(open(env, { outputSchema: { type: "object" } })).rejects.toMatchObject({ option: "outputSchema" });
      expect(env.raw).toEqual([]);
      const session = await open(env, { systemPrompt: "REPLACE_QWEN", appendSystemPrompt: "APPEND_QWEN", disallowedTools: ["run_shell_command"] });
      try {
        expect(await turn(session)).toEqual({ kind: "completed" });
        const requests = env.raw.map((request) => asRecord(request.body));
        expect(JSON.stringify(requests)).toContain("REPLACE_QWEN");
        expect(JSON.stringify(requests)).toContain("APPEND_QWEN");
        const agent = requests.findLast((request) => Array.isArray(request?.tools));
        expect(agent).toBeDefined();
        expect(JSON.stringify(agent?.tools)).not.toContain('"name":"run_shell_command"');
      } finally { await session.dispose(); }
    } finally { await env.stop(); }
  }, 60_000);

  test("a missing resume is an explicit native error", async () => {
    const env = await startQwenAimock();
    try { await expect(open(env, { resume: randomUUID() })).rejects.toThrow(/session|resume/iu); }
    finally { await env.stop(); }
  }, 45_000);

  test("a held extension-store lock surfaces the native startup failure without a provider request", async () => {
    const env = await startQwenAimock();
    try {
      // proper-lockfile's on-disk lock directory, kept fresh for the native retry budget.
      const lock = path.join(env.env.HOME ?? "", ".qwen", "extension-store", "lock.lock");
      await mkdir(lock, { recursive: true });
      const session = await open(env);
      try {
        const outcome = await turn(session);
        expect(outcome.kind).toBe("failed");
        if (outcome.kind !== "failed") { throw new Error("Expected native startup failure"); }
        expect(outcome.failure).toBe("unknown");
        expect(outcome.reason).toContain("Extension store is busy");
        expect(env.raw).toEqual([]);
      } finally { await session.dispose(); }
    } finally { await env.stop(); }
  }, 60_000);
});
