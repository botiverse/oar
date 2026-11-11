import { afterEach, expect, test, vi } from "vitest";
import { RuntimeFailureError } from "../../packages/oar/src/contracts/runtime-failure-error.js";
import type { SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { codexControlRefusal, codexVersion } from "../../packages/oar/src/runtimes/codex/refusal.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "codex" } as const;
const threadId = "thread-1";

afterEach(() => { spawnLineProcess.mockReset(); });

// Native answers as codex-cli wrote them (scratch probes of 0.118.0 to 0.135.0 and 0.154.0, 2026-11-11).
const OLD_TIER = "Invalid request: unknown variant `default`, expected `fast` or `flex`";
const NO_SETTINGS_UPDATE = "Invalid request: unknown variant `thread/settings/update`, expected one of `initialize`, `thread/start`, `thread/resume`";
const BAD_CONFIG = "failed to load configuration: /home/u/.codex/config.toml:3:9: unclosed array table, expected `]]`";

const opened = (params: JsonRecord): JsonRecord => ({ thread: { id: threadId }, model: "gpt-5.5", modelProvider: "openai", serviceTier: params.serviceTier ?? null, reasoningEffort: "medium" });

/** A scripted app-server: `answer` may answer a request itself (an error object), otherwise a plain success. */
function serve(version: string, answer: (method: string, params: JsonRecord) => JsonRecord | null): FakeLineProcess {
  const fake = fakeLineProcess((text, child) => {
    const request = asRecord(JSON.parse(text));
    if (typeof request?.id !== "number" || typeof request.method !== "string") { return; }
    const params = asRecord(request.params) ?? {};
    const error = answer(request.method, params);
    const results: Readonly<Record<string, JsonRecord>> = {
      initialize: { userAgent: `oar/${version} (Debian 13.0.0; aarch64) xterm-256color (oar; 0.0.0)` },
      "thread/start": opened(params),
      "thread/resume": opened(params),
      "turn/start": { turn: { id: "turn-1" } },
    };
    const result = Object.hasOwn(results, request.method) ? results[request.method] : {};
    child.emit(`${JSON.stringify({ id: request.id, ...(error === null ? { result } : { error }) })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  return fake;
}

async function openFailure(options: Omit<SessionOptions, "cwd">): Promise<unknown> {
  try {
    const session = await codexSession(installation, { cwd: process.cwd(), ...options });
    await session.dispose();
    return null;
  } catch (error) { return error; }
}

test("a Codex too old for serviceTier default fails the open as runtime_outdated, naming its version and the first that accepts it", async () => {
  const fake = serve("0.125.0", (method) => method === "thread/start" ? { code: -32_600, message: OLD_TIER } : null);
  const failure = await openFailure({ serviceTier: "default" });
  expect(failure).toBeInstanceOf(RuntimeFailureError);
  expect(failure).toMatchObject({ failure: "invalid_request", code: "runtime_outdated", cause: { method: "thread/start", native: { code: -32_600, message: OLD_TIER } } });
  expect(failure instanceof Error ? failure.message : "").toBe("Codex 0.125.0 does not accept serviceTier default (it accepts fast and flex); update Codex to 0.129.0 or newer");
  expect(fake.killed()).toBe(true);
});

test("a tier no Codex release accepts is not called outdated", async () => {
  serve("0.125.0", (method) => method === "thread/start" ? { code: -32_600, message: "Invalid request: unknown variant `turbo`, expected `fast` or `flex`" } : null);
  const failure = await openFailure({ serviceTier: "turbo" });
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(RuntimeFailureError);
});

test("a resume that needs thread/settings/update on a Codex without it fails as runtime_outdated", async () => {
  serve("0.132.0", (method) => method === "thread/settings/update" ? { code: -32_600, message: NO_SETTINGS_UPDATE } : null);
  const failure = await openFailure({ resume: threadId, effort: "high" });
  expect(failure).toMatchObject({ failure: "invalid_request", code: "runtime_outdated" });
  expect(failure instanceof Error ? failure.message : "").toBe("Codex 0.132.0 does not know thread/settings/update, which OAR needs to set the effort of a resumed thread; update Codex to 0.133.0 or newer");
});

test.each(["thread/start", "thread/resume"])("an unreadable config.toml on %s fails as runtime_config_invalid with Codex's file, line and words", async (method) => {
  serve("0.154.0", (called) => called === method ? { code: -32_600, message: BAD_CONFIG } : null);
  const failure = await openFailure(method === "thread/resume" ? { resume: threadId } : {});
  expect(failure).toMatchObject({ failure: "invalid_request", code: "runtime_config_invalid" });
  expect(failure instanceof Error ? failure.message : "").toBe(`codex ${method} failed: ${BAD_CONFIG}`);
});

test("a refused turn/start is recorded with its code and native error", async () => {
  serve("0.154.0", (method) => method === "turn/start" ? { code: -32_600, message: `thread not found: ${threadId}` } : null);
  const session = await codexSession(installation, { cwd: process.cwd() });
  try {
    const result = await session.prompt("hi");
    expect(result).toMatchObject({ kind: "rejected", code: "session_not_found", reason: `thread not found: ${threadId}`, response: { body: { native: { code: -32_600 } } } });
    expect(result).not.toHaveProperty("failure");
    expect(session.status().value.kind).toBe("idle");
  } finally { await session.dispose(); }
});

test.each([
  { name: "this process has no such thread", native: { code: -32_600, message: "thread not found: t" }, code: "session_not_found", failure: undefined },
  { name: "the input is over Codex's limit", native: { code: -32_602, message: "Input exceeds the maximum length of 1048576 characters.", data: { input_error_code: "input_too_large", max_chars: 1_048_576, actual_chars: 2_000_000 } }, code: "runtime_refused", failure: "input_too_large" },
  { name: "the request queue is full", native: { code: -32_001, message: "Server overloaded; retry later." }, code: "runtime_refused", failure: "overloaded" },
  { name: "the configuration does not load", native: { code: -32_600, message: BAD_CONFIG }, code: "runtime_refused", failure: "invalid_request" },
  { name: "the thread's model provider is not configured", native: { code: -32_600, message: "model provider x is not configured", data: { type: "modelProviderNotConfigured", modelProvider: "x" } }, code: "runtime_refused", failure: "invalid_request" },
  { name: "Codex says something else", native: { code: -32_603, message: "failed to submit turn input: X" }, code: "runtime_refused", failure: undefined },
  { name: "the server is draining", native: { code: -32_600, message: "Server is draining; retry after reconnecting", data: { reason: "serverShuttingDown" } }, code: "runtime_refused", failure: undefined },
])("a control refusal where $name", ({ native, code, failure }) => {
  const rejection = codexControlRefusal(native.message, native);
  expect(rejection).toEqual({ kind: "rejected", code, reason: native.message, native, ...(failure === undefined ? {} : { failure }) });
});

test("a refused prompt's class reaches the host's outcome", async () => {
  serve("0.154.0", (method) => method === "turn/start" ? { code: -32_602, message: "Input exceeds the maximum length of 1048576 characters.", data: { input_error_code: "input_too_large" } } : null);
  const session = await codexSession(installation, { cwd: process.cwd() });
  try {
    expect(await session.prompt("hi")).toMatchObject({ kind: "rejected", code: "runtime_refused", failure: "input_too_large" });
  } finally { await session.dispose(); }
});

test("the version comes from initialize's userAgent", () => {
  expect(codexVersion({ userAgent: "oar/0.130.0-alpha.5 (Windows 10; x86_64) (oar; 0.0.0)" })).toBe("0.130.0-alpha.5");
  expect(codexVersion({ userAgent: "no version here" })).toBeNull();
  expect(codexVersion({})).toBeNull();
});
