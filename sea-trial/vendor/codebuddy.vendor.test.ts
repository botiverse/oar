import { asRecord, asRecordList } from "../../packages/oar/src/shared/json.js";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { echoServers, startHttpEcho, scriptEchoes, echoesReceived, EXPECTED_ECHOES, HTTP_AUTHORIZATION, STDIO_TOKEN, leakedCredentials } from "./support/echo-mcp.js";
import { expect, test } from "vitest";
import { codebuddyRuntime } from "../../packages/oar/src/runtimes/codebuddy/index.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { startCodebuddyAimock } from "../harness/codebuddy-aimock.js";
import { expectAvailable } from "./support/asserts.js";

const enabled = process.env.OAR_TEST === "codebuddy-aimock";

test.skipIf(!enabled)("CodeBuddy ACP sends immediate consecutive inputs once, then resumes with its history", async () => {
  const provider = await startCodebuddyAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); });
  let session: Session | undefined = undefined;
  try {
    const installation = await codebuddyRuntime.installation();
    expectAvailable(installation, "CodeBuddy");
    const options = { cwd: provider.cwd, env: provider.env, model: "deepseek-flash" };
    const catalog = await codebuddyRuntime.listModels(installation, options);
    expect(catalog.kind).toBe("ok");
    session = await codebuddyRuntime.session(installation, options);
    for (const input of ["FIRST_INPUT", "SECOND_INPUT"]) {
      expect(await promptAndWait(session, input, { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" }, text: "ok" });
    }
    const id = session.id;
    await session.dispose();
    session = await codebuddyRuntime.session(installation, { ...options, resume: id });
    expect(session.id).toBe(id);
    expect(await promptAndWait(session, "RESUMED_INPUT", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" }, text: "ok" });
    const conversations = provider.raw.map((request) => asRecord(request.body)).filter((body) => !asRecordList(body?.messages).some((message) => message.role === "system" && typeof message.content === "string" && message.content.startsWith("Generate a concise, sentence-case title")));
    expect(conversations).toHaveLength(3);
    expect(JSON.stringify(conversations[2]?.messages)).toContain("FIRST_INPUT");
    expect(JSON.stringify(conversations[2]?.messages)).toContain("SECOND_INPUT");
    expect(typeof session.steer).toBe("undefined");
  } finally { await session?.dispose(); await provider.stop(); }
}, 120_000);

test.skipIf(!enabled)("CodeBuddy ACP reports a provider failure rather than a successful answer", async () => {
  const provider = await startCodebuddyAimock((mock) => { mock.onMessage(/[\s\S]*/u, { status: 401, error: { type: "invalid_request_error", code: "invalid_api_key", message: "Invalid synthetic key" } }); });
  let session: Session | undefined = undefined;
  try {
    const installation = await codebuddyRuntime.installation();
    expectAvailable(installation, "CodeBuddy");
    session = await codebuddyRuntime.session(installation, { cwd: provider.cwd, env: provider.env, model: "deepseek-flash" });
    const run = await promptAndWait(session, "Failure probe", { timeoutMs: 30_000 });
    await mkdir("oar-trial-run", { recursive: true });
    await writeFile(process.env.OAR_CODEBUDDY_ERROR_TRACE ?? "oar-trial-run/codebuddy-error.json", JSON.stringify({ run, records: session.records() }, null, 2));
    expect(run).toMatchObject({ kind: "ended", outcome: { kind: "failed", failure: "auth", status: 401 } });
  } finally { await session?.dispose(); await provider.stop(); }
}, 90_000);

test.skipIf(!enabled)("CodeBuddy applies private replacement prompts and tool denials on new and resumed ACP sessions", async () => {
  const provider = await startCodebuddyAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); });
  let session: Session | undefined = undefined;
  const systemPrompt = "OAR_PRIVATE_REPLACEMENT_47 You are a concise assistant.";
  try {
    const installation = await codebuddyRuntime.installation();
    expectAvailable(installation, "CodeBuddy");
    const options = { cwd: provider.cwd, env: provider.env, model: "deepseek-flash", systemPrompt, disallowedTools: ["Bash"] };
    session = await codebuddyRuntime.session(installation, options);
    expect(await promptAndWait(session, "Replacement first", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    const id = session.id;
    await session.dispose();
    session = await codebuddyRuntime.session(installation, { ...options, resume: id });
    expect(await promptAndWait(session, "Replacement resume", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    const requests = provider.raw.map((request) => asRecord(request.body)).filter((body) => Array.isArray(body?.tools));
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const system = asRecordList(request?.messages).filter((message) => message.role === "system").map((message) => message.content);
      expect(system).toEqual([systemPrompt]);
      const toolNames = asRecordList(request?.tools).map((tool) => asRecord(tool.function)?.name);
      expect(toolNames.length).toBeGreaterThan(0);
      expect(toolNames).not.toContain("Bash");
    }
  } finally { await session?.dispose(); await provider.stop(); }
}, 90_000);

async function credentialFiles(directory: string, values: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { found.push(...await credentialFiles(file, values)); }
    else if (entry.isFile()) {
      const content = await readFile(file);
      if (values.some((value) => content.includes(Buffer.from(value)))) { found.push(file); }
    }
  }
  return found;
}

test.skipIf(!enabled)("CodeBuddy attaches stdio and HTTP MCP, reapplies on resume, and leaves no credentials in records or native files", async () => {
  const provider = await startCodebuddyAimock((mock) => { scriptEchoes(mock); mock.onMessage(/[\s\S]*/u, { content: "ok" }); });
  const http = await startHttpEcho();
  let session: Session | undefined = undefined;
  try {
    const installation = await codebuddyRuntime.installation();
    expectAvailable(installation, "CodeBuddy");
    const options = { cwd: provider.cwd, env: provider.env, model: "deepseek-flash", mcpServers: echoServers(http.url) };
    session = await codebuddyRuntime.session(installation, options);
    expect(await promptAndWait(session, "please call both echo tools", { timeoutMs: 60_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    const id = session.id;
    const first = session;
    await session.dispose();
    session = await codebuddyRuntime.session(installation, { ...options, resume: id });
    expect(await promptAndWait(session, "please call the echo tool again", { timeoutMs: 60_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    expect(echoesReceived(provider.raw)).toEqual(EXPECTED_ECHOES);
    expect(leakedCredentials(first, session)).toEqual([]);
    await session.dispose();
    const home = provider.env.HOME;
    expect(home).toBeDefined();
    expect(await credentialFiles(home ?? "", [STDIO_TOKEN, HTTP_AUTHORIZATION, "oar-http-credential"])).toEqual([]);
  } finally { await session?.dispose(); await provider.stop(); http.stop(); }
}, 180_000);


test.skipIf(!enabled)("CodeBuddy resumes in the requested working directory, not the original directory", async () => {
  const provider = await startCodebuddyAimock((mock) => {
    mock.on({ userMessage: /where-is-cwd/u, hasToolResult: false }, { toolCalls: [{ name: "Bash", arguments: JSON.stringify({ command: "pwd" }) }] });
    mock.on({ hasToolResult: true }, { content: "cwd observed" });
    mock.onMessage(/seed/u, { content: "seeded" });
  });
  let session: Session | undefined = undefined;
  try {
    const installation = await codebuddyRuntime.installation();
    expectAvailable(installation, "CodeBuddy");
    const options = { cwd: provider.cwd, env: provider.env, model: "deepseek-flash" };
    session = await codebuddyRuntime.session(installation, options);
    expect(await promptAndWait(session, "seed", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    const id = session.id;
    await session.dispose();
    const cwd = path.join(provider.cwd, "elsewhere");
    await mkdir(cwd);
    session = await codebuddyRuntime.session(installation, { ...options, cwd, resume: id });
    const run = await promptAndWait(session, "where-is-cwd", { timeoutMs: 30_000 });
    expect(run).toMatchObject({ kind: "ended", outcome: { kind: "completed" }, text: "cwd observed" });
    const output = provider.raw.flatMap((request) => asRecordList(asRecord(request.body)?.messages))
      .filter((message) => message.role === "tool").map((message) => message.content);
    // macOS can canonicalize /var to /private/var; both retain this unique directory.
    expect(JSON.stringify(output)).toContain(cwd);
  } finally { await session?.dispose(); await provider.stop(); }
}, 90_000);
