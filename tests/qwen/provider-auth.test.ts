import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createQwenProviderAuth, QwenProviderAuthError } from "../../packages/oar/src/runtimes/qwen/provider-auth.js";
import { spawnLineProcess } from "../../packages/oar/src/shared/executable/index.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess: vi.fn() }));
const installation = { kind: "available", via: "executable", command: "qwen-fixture" } as const;
const secret = "synthetic-key-must-stay-on-stdin";
const metadata = { id: "native", label: "Native provider", protocol: "openai", models: [{ id: "model" }], existingConfig: { modelIds: ["model"], customField: 1 } };
const success = { success: true, providerId: "native", providerLabel: "Native provider", authType: "openai", modelId: "model" };
const children: FakeLineProcess[] = [];

function fixture(answer: (request: JsonRecord, child: FakeLineProcess) => void) {
  const child = fakeLineProcess();
  const requests: JsonRecord[] = [];
  child.stdin.on("data", (data: Buffer) => {
    for (const line of data.toString().trim().split("\n")) {
      const request = asRecord(parseJson(line));
      if (request !== null) { requests.push(request); answer(request, child); }
    }
  });
  children.push(child);
  vi.mocked(spawnLineProcess).mockReturnValueOnce(child);
  return { child, requests };
}
function reply(child: FakeLineProcess, request: JsonRecord, result: unknown): void {
  child.emit(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
function initialize(child: FakeLineProcess, request: JsonRecord): boolean {
  if (request.method !== "initialize") { return false; }
  reply(child, request, { protocolVersion: 1, agentCapabilities: {} });
  return true;
}
function responds(result: unknown) {
  return fixture((request, child) => { if (!initialize(child, request)) { reply(child, request, result); } });
}
afterEach(() => {
  for (const child of children.splice(0)) { child.kill(); }
  vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs();
});

test("factory is lazy; each listing preserves native metadata and starts only one bounded reader", async () => {
  const auth = await createQwenProviderAuth(installation);
  expect(spawnLineProcess).not.toHaveBeenCalled();
  const first = responds({ providers: [metadata] });
  expect(await auth.listProviders()).toEqual([metadata]);
  expect(first.requests.map((row) => row.method)).toEqual(["initialize", "qwen/providers/list"]);
  expect(first.child.killed()).toBe(true);
  const second = responds({ providers: [{ id: "new", label: "New", protocol: "gemini" }] });
  expect(await auth.listProviders()).toEqual([{ id: "new", label: "New", protocol: "gemini" }]);
  expect(second.child.killed()).toBe(true);
});

// oxlint-disable-next-line max-statements -- One operation checks the secret-bearing wire and the non-secret process boundary together.
test("connect sends the native fields only on stdin, preserving environment and scope semantics", async () => {
  vi.stubEnv("OAR_PROVIDER_REMOVE", "remove-me");
  vi.stubEnv("OAR_CHILD_STDERR", "inherit");
  const setup = responds(success);
  const auth = await createQwenProviderAuth(installation, { cwd: "project", env: { HOME: "isolated-home", OAR_PROVIDER_REMOVE: null } });
  const input = { providerId: "native", apiKey: secret, baseUrl: "http://localhost/v1", protocol: "openai", wireApi: "responses", modelIds: ["model", "other"], scope: "workspace" } as const;
  expect(await auth.connect(input)).toEqual(success);
  expect(setup.requests[1]).toMatchObject({ method: "qwen/providers/connect", params: input });
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest nested matcher.
  expect(spawnLineProcess).toHaveBeenCalledWith("qwen-fixture", ["--acp"], expect.objectContaining({ cwd: path.resolve("project"), killTree: true, inheritStderr: false, env: expect.objectContaining({ HOME: "isolated-home" }) }));
  const [spawn] = vi.mocked(spawnLineProcess).mock.calls;
  expect(spawn?.[2]?.env?.OAR_PROVIDER_REMOVE).toBeUndefined();
  expect(JSON.stringify(spawn)).not.toContain(secret);
  expect(process.env.OAR_PROVIDER_REMOVE).toBe("remove-me");
  expect(setup.child.killed()).toBe(true);
});

test("omitted key and scope stay omitted; even a short supplied key is redacted from later native results", async () => {
  const auth = await createQwenProviderAuth(installation);
  responds(success);
  await auth.connect({ providerId: "native", apiKey: "xy" });
  const update = responds({ ...success, providerLabel: "xy" });
  expect(await auth.connect({ providerId: "native", modelIds: ["model"] })).toEqual({ ...success, providerLabel: "[redacted]" });
  expect(update.requests[1]?.params).toEqual({ providerId: "native", modelIds: ["model"] });
});

test.each([-32_602, -32_603, -32_601])("native failure preserves ACP code %i without raw details, stderr or a secret cause", async (code) => {
  const consoleError = vi.spyOn(console, "error");
  const setup = fixture((request, child) => {
    if (initialize(child, request)) { return; }
    child.emitStderr(`native secret ${secret}`);
    child.emit(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code, message: secret, data: { storedKey: "previously-stored-secret", nested: { [secret]: secret } } } })}\n`);
  });
  const auth = await createQwenProviderAuth(installation);
  await expect(auth.connect({ providerId: "native", apiKey: secret })).rejects.toSatisfy((error: unknown) => {
    expect(error).toBeInstanceOf(QwenProviderAuthError);
    expect(error).toMatchObject({ kind: "native", code, method: "qwen/providers/connect" });
    expect(asRecord(error)?.cause).toBeUndefined();
    expect(asRecord(error)?.data).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain("previously-stored-secret");
    return true;
  });
  expect(consoleError).not.toHaveBeenCalled();
  expect(setup.child.killed()).toBe(true);
});

test("malformed stdout, unknown replies and notifications cannot send credentials to SDK logs", async () => {
  const logger = vi.spyOn(console, "error");
  fixture((request, child) => {
    if (initialize(child, request)) { return; }
    child.emit(`${JSON.stringify({ secret })}\n`);
    child.emit(`${JSON.stringify({ jsonrpc: "2.0", method: "unexpected", params: { storedKey: "unseen-key" } })}\n`);
    child.emit(`${JSON.stringify({ jsonrpc: "2.0", id: secret, error: { code: -32_603, message: secret } })}\n`);
    reply(child, request, success);
  });
  const auth = await createQwenProviderAuth(installation);
  await auth.connect({ providerId: "native", apiKey: secret });
  expect(logger).not.toHaveBeenCalled();
});

test.each([{ providers: {} }, { providers: [{ id: "incomplete" }] }, { providers: [{ ...metadata, existingConfig: false }] }])("malformed metadata rejects rather than claiming no providers", async (result) => {
  const setup = responds(result);
  const auth = await createQwenProviderAuth(installation);
  await expect(auth.listProviders()).rejects.toMatchObject({ kind: "invalid_response" });
  expect(setup.child.killed()).toBe(true);
});

test("a false or incomplete connect result is not reported as configured", async () => {
  responds({ success: false });
  const auth = await createQwenProviderAuth(installation);
  await expect(auth.connect({ providerId: "native" })).rejects.toMatchObject({ kind: "invalid_response" });
});

test("initialize timeout kills the reader without sending connect", async () => {
  vi.useFakeTimers();
  const setup = fixture(() => {});
  const auth = await createQwenProviderAuth(installation, { timeoutMs: 30 });
  const pending = expect(auth.connect({ providerId: "native", apiKey: secret })).rejects.toMatchObject({ kind: "timeout" });
  await vi.advanceTimersByTimeAsync(30);
  await pending;
  expect(setup.requests.filter((row) => row.method === "qwen/providers/connect")).toEqual([]);
  expect(setup.child.killed()).toBe(true);
});

test("the total budget covers initialize and connect; a lost write outcome is not retried", async () => {
  vi.useFakeTimers();
  let writes = 0;
  const setup = fixture((request, child) => {
    if (request.method === "initialize") { setTimeout(() => { initialize(child, request); }, 20); }
    if (request.method === "qwen/providers/connect") { writes += 1; }
  });
  const auth = await createQwenProviderAuth(installation, { timeoutMs: 30 });
  const pending = expect(auth.connect({ providerId: "native", apiKey: secret })).rejects.toMatchObject({ kind: "timeout" });
  await vi.advanceTimersByTimeAsync(30);
  await pending;
  expect(writes).toBe(1);
  expect(spawnLineProcess).toHaveBeenCalledTimes(1);
  expect(setup.child.killed()).toBe(true);
});

test("early native exit and spawn errors do not leak native diagnostics", async () => {
  fixture((request, child) => { if (!initialize(child, request)) { child.end(7); } });
  const auth = await createQwenProviderAuth(installation);
  await expect(auth.listProviders()).rejects.toMatchObject({ kind: "process_exited" });
  vi.mocked(spawnLineProcess).mockImplementationOnce(() => { throw new Error(secret, { cause: { env: secret } }); });
  await expect(auth.connect({ providerId: "native", apiKey: secret })).rejects.toSatisfy((error: unknown) => {
    expect(error).toMatchObject({ kind: "launch_failed" });
    expect(String(error)).not.toContain(secret);
    expect(asRecord(error)?.cause).toBeUndefined();
    return true;
  });
});

test.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])("invalid budget %s rejects before starting Qwen", async (timeoutMs) => {
  await expect(createQwenProviderAuth(installation, { timeoutMs })).rejects.toBeInstanceOf(RangeError);
  expect(spawnLineProcess).not.toHaveBeenCalled();
});
