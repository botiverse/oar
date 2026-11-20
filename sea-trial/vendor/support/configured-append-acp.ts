import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
import { antigravityRuntime, grokRuntime, promptAndWait, qoderRuntime, type SessionOptions } from "../../../packages/oar/src/index.js";
import { asRecord, parseJson } from "../../../packages/oar/src/shared/json.js";
import { startAntigravityAimock, startGrokAimock } from "../../harness/aimock-acp.js";
import type { ConfiguredAppendFixture } from "./configured-append.js";
import { qoderFixture } from "./qoder-fixture.js";

/** Global `~/.gemini/GEMINI.md` alongside Antigravity's `_meta.antigravity.systemPrompt.append`. */
export async function antigravityConfiguredFixture(): Promise<ConfiguredAppendFixture> {
  const provider = await startAntigravityAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); });
  const cwd = await mkdtemp(path.join(tmpdir(), "oar-configured-append-agy-"));
  onTestFinished(async () => {
    try { await provider.stop(); } finally { await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
  });
  const home = provider.env.HOME;
  assert.ok(home !== undefined);
  const install = await antigravityRuntime.installation();
  assert.ok(install.kind === "available");
  return {
    raw: provider.raw,
    placement: "system",
    configure: async (value: string) => { await writeFile(path.join(home, ".gemini", "GEMINI.md"), value); },
    open: async (options: Partial<SessionOptions>) => {
      const session = await antigravityRuntime.session(install, { cwd, env: { ...provider.env }, ...options });
      return session;
    },
  };
}

/** Global `$GROK_HOME/AGENTS.md` (user-role project instructions) alongside Grok's `_meta.rules` system append. */
export async function grokConfiguredFixture(): Promise<ConfiguredAppendFixture> {
  const provider = await startGrokAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); });
  const cwd = await mkdtemp(path.join(tmpdir(), "oar-configured-append-grok-"));
  onTestFinished(async () => {
    try { await provider.stop(); } finally { await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
  });
  const grokHome = provider.env.GROK_HOME;
  assert.ok(grokHome !== undefined);
  const install = await grokRuntime.installation();
  assert.ok(install.kind === "available");
  return {
    raw: provider.raw,
    placement: "user_context",
    configure: async (value: string) => { await writeFile(path.join(grokHome, "AGENTS.md"), value); },
    open: async (options: Partial<SessionOptions>) => {
      const session = await grokRuntime.session(install, { cwd, env: { ...provider.env }, ...options });
      return session;
    },
  };
}

/**
 * Extract Qoder's full `chatAsk` payload from its exhausted fake-response replay record.
 * Depends on the private replay error format observed on qodercli 1.1.78
 * ("No more mock responses for generateContentStream" and the `got request:` line
 * in `errorDetails`, matching `qoder-prompts.vendor.test.ts`); if Qoder rewords it,
 * the assertions below fail loudly.
 */
async function savedQoderRequest(home: string, sessionId: string): Promise<unknown> {
  const projects = path.join(home, ".qoder", "projects");
  const files = await readdir(projects, { recursive: true });
  const file = files.find((entry) => path.basename(entry) === `${sessionId}.jsonl`);
  assert.ok(file !== undefined, "Qoder did not save the native conversation");
  const content = await readFile(path.join(projects, file), "utf8");
  const records = content.trim().split("\n").map((line) => asRecord(parseJson(line)));
  const error = records.findLast((record) => typeof record?.errorDetails === "string" && record.errorDetails.includes("No more mock responses for generateContentStream"));
  assert.ok(typeof error?.errorDetails === "string", "Qoder did not retain its exhausted-replay request");
  const requestLine = error.errorDetails.split("got request:\n")[1]?.split("\n")[0];
  assert.ok(requestLine !== undefined && requestLine !== "", error.errorDetails);
  const chatAsk = asRecord(asRecord(parseJson(requestLine))?.chatAsk);
  assert.ok(chatAsk !== null, requestLine);
  const messages = Array.isArray(chatAsk.messages)
    ? chatAsk.messages.map((entry) => {
      const record = asRecord(entry);
      return { role: record?.role, content: record?.content };
    })
    : [];
  return { system: chatAsk.system, messages };
}

/** Global `~/.qoder/AGENTS.md` (user-role context) alongside Qoder's `--append-system-prompt-file` system blocks. */
export async function qoderConfiguredFixture(): Promise<ConfiguredAppendFixture> {
  const env = await qoderFixture([]);
  const install = await qoderRuntime.installation();
  assert.ok(install.kind === "available");
  return {
    raw: [],
    placement: "user_context",
    configure: async (value: string) => {
      await mkdir(path.join(env.home, ".qoder"), { recursive: true });
      await writeFile(path.join(env.home, ".qoder", "AGENTS.md"), value);
    },
    open: async (options: Partial<SessionOptions>) => {
      const session = await qoderRuntime.session(install, { ...env.options, model: "efficient", ...options });
      return session;
    },
    captureTurn: async (session, prompt) => {
      const result = await promptAndWait(session, prompt, { timeoutMs: 30_000 });
      assert.ok(result.kind === "ended" && result.outcome.kind === "failed", JSON.stringify(result));
      return [{ path: "chatAsk", body: await savedQoderRequest(env.home, session.id) }];
    },
  };
}
