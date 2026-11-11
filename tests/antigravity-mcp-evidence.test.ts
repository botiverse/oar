/* oxlint-disable eslint/max-statements, typescript/no-unsafe-assignment -- Integration assertions keep fixture setup, retention, verification and cleanup together; Vitest asymmetric matchers are untyped. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, test, vi } from "vitest";
import { createAntigravityMcpEvidence, sanitizeAntigravityLog } from "../sea-trial/vendor/support/antigravity-mcp-evidence.js";
import { ECHO_SERVER } from "../sea-trial/vendor/support/echo-mcp.js";

afterEach(() => { vi.unstubAllEnvs(); });

test("native diagnostics remove home names, known credentials, URLs and whole multiline credential entries", () => {
  const lines = [
    String.raw`I1111 10:00:00.000 startup] /Users/Alice Example/home C:\Users\Bob Example\log`,
    'I1111 10:00:01.000 MCP] /fixture/home/log known-value-123 https://user:password@example.invalid/?token=unknown',
    'I1111 10:00:02.000 config] {"Authorization": "Bearer secret-one",',
    '  "next": "secret-continuation"}',
    'I1111 10:00:03.000 MCP] startup finished',
    'I1111 10:00:04.000 config] refresh_token=',
    'unlabelled-secret-value',
    'I1111 10:00:05.000 MCP] tools/list replied',
    String.raw`I1111 10:00:06.000 config] {\"refresh_token\":\"escaped-secret-value\"}`,
  ];
  const clean = sanitizeAntigravityLog(lines.join("\n"), ["/fixture/home"], ["known-value-123"]);
  expect(clean).not.toMatch(/Alice|Bob|fixture|known-value|password|secret-one|secret-continuation|unlabelled-secret|escaped-secret|example\.invalid/u);
  expect(clean).toContain("startup finished");
  expect(clean).toContain("tools/list replied");
});

test("keeps bounded sanitized native logs and explicit missing MCP evidence outside the disposable HOME", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oar-aimock-evidence-test-"));
  const evidence = await createAntigravityMcpEvidence();
  assert.ok(evidence);
  const gemini = path.join(root, "home", ".gemini");
  const logDir = path.join(gemini, "antigravity-cli", "log");
  const artifacts = path.join(root, "artifacts");
  vi.stubEnv("OAR_TRIAL_RUN_DIR", artifacts);
  try {
    await mkdir(logDir, { recursive: true });
    await Promise.all([0, 1, 2, 3, 4].map(async index => writeFile(path.join(logDir, `acp-worker-${String(index)}.log`),
      `I1111 10:00:00.000 init] ${gemini} synthetic-key-123\nI1111 10:00:01.000 MCP] started\n`)));
    await writeFile(path.join(logDir, "settings.json"), "must-not-be-copied");
    await writeFile(path.join(evidence.directory, "session-echo.jsonl"), '{"event":"started"}\n');
    await evidence.retain(gemini, { HOME: path.join(root, "home"), GEMINI_API_KEY: "synthetic-key-123" });
    await rm(path.join(root, "home"), { recursive: true });
    const [id] = await readdir(path.join(artifacts, "agy-mcp-failure"));
    const destination = path.join(artifacts, "agy-mcp-failure", id ?? "missing");
    const manifest = await readFile(path.join(destination, "manifest.json"), "utf8");
    expect(JSON.parse(manifest)).toMatchObject({ nativeDirectoryReadable: true, omittedNativeFiles: 1, files: expect.arrayContaining([
      { file: "user-echo.jsonl", kind: "mcp", error: "unavailable" },
    ]) });
    const files = await readdir(destination);
    const contents = await Promise.all(files.map(async file => readFile(path.join(destination, file), "utf8")));
    const retained = contents.join("\n");
    expect(retained).not.toMatch(/synthetic-key|must-not-be-copied/u);
    expect(retained).not.toContain(root);
    // Replacing the key inside the path first must not leave a partly redacted HOME.
    expect(retained).not.toMatch(/oar-(?:aimock|\[redacted\])-evidence/u);
    expect(retained).toContain("MCP] started");
    expect(retained).toContain('"event":"started"');
  } finally { await evidence.remove(); await rm(root, { recursive: true, force: true }); }
});

test("cropped credential lines and unfinished writes are discarded, and truncation is reported", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oar-agy-evidence-budget-"));
  const evidence = await createAntigravityMcpEvidence();
  assert.ok(evidence);
  vi.stubEnv("OAR_TRIAL_RUN_DIR", path.join(root, "artifacts"));
  try {
    const logDir = path.join(root, "antigravity-cli", "log");
    await mkdir(logDir, { recursive: true });
    await writeFile(path.join(logDir, "acp-worker-1.log"), `token=${"s".repeat(600_000)}secret-tail\nmultiline-secret-continuation\nI1111 10:00:01.000 MCP] good\nuncompleted-secret`);
    await evidence.retain(root, {});
    const [id] = await readdir(path.join(root, "artifacts", "agy-mcp-failure"));
    const target = path.join(root, "artifacts", "agy-mcp-failure", id ?? "missing");
    expect(await readFile(path.join(target, "native-0.log"), "utf8")).toBe("I1111 10:00:01.000 MCP] good\n");
    const manifest = await readFile(path.join(target, "manifest.json"), "utf8");
    expect(JSON.parse(manifest)).toMatchObject({ files: expect.arrayContaining([expect.objectContaining({ file: "native-0.log", truncated: true })]) });
  } finally { await evidence.remove(); await rm(root, { recursive: true, force: true }); }
});

test("an unwritable artifact destination never throws over the caller's failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oar-agy-evidence-failure-"));
  const evidence = await createAntigravityMcpEvidence();
  assert.ok(evidence);
  const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const file = path.join(root, "file");
    await writeFile(file, "not a directory");
    vi.stubEnv("OAR_TRIAL_RUN_DIR", file);
    await expect(evidence.retain(root, {})).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith("[oar fixture] Antigravity MCP failure evidence could not be retained\n");
  } finally { warning.mockRestore(); await evidence.remove(); await rm(root, { recursive: true, force: true }); }
});

async function exchange(evidenceFile: string): Promise<readonly unknown[]> {
  const child = spawn(process.execPath, [ECHO_SERVER, "--evidence", evidenceFile], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OAR_ECHO_TOKEN: "synthetic-server-secret" } });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const replies: unknown[] = [];
  try {
    for (const message of [
      { jsonrpc: "2.0", id: "sensitive-id", method: "initialize", params: { protocolVersion: "2025-06-18", token: "sensitive-parameter" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "sensitive-input" } } },
    ]) {
      const reply = "id" in message ? once(lines, "line") : undefined;
      child.stdin.write(`${JSON.stringify(message)}\n`);
      // oxlint-disable-next-line no-await-in-loop -- Exercise the real handshake in protocol order.
      if (reply !== undefined) { const [line] = await reply; replies.push(JSON.parse(String(line))); }
    }
    child.stdin.end();
    expect(await exited).toEqual([0, null]);
    return replies;
  } finally { lines.close(); if (child.exitCode === null) { child.kill(); await exited; } }
}

test("the real echo process records startup and handshake stages without payloads; a broken recorder preserves protocol", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oar-mcp-handshake-"));
  try {
    const trace = path.join(root, "trace.jsonl");
    const replies = await exchange(trace);
    const text = await readFile(trace, "utf8");
    expect(text).not.toMatch(/sensitive|synthetic-server|sensitive-id/u);
    const events = text.trim().split("\n").map((line): unknown => JSON.parse(line));
    expect(events).toEqual([
      ["started", null], ["received", "initialize"], ["replied", "initialize"],
      ["received", "notifications/initialized"], ["received", "tools/list"], ["replied", "tools/list"],
      ["received", "tools/call"], ["replied", "tools/call"], ["stdin_closed", null], ["exit", null],
    ].map(([event, method]): unknown => expect.objectContaining(method === null ? { event } : { event, method })));
    expect(await exchange(path.join(root, "absent", "trace.jsonl"))).toEqual(replies);
  } finally { await rm(root, { recursive: true, force: true }); }
});
