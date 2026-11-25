import { resolve } from "node:path";
import { readerEnvironment, expectReaderEnvironment } from "../fixtures/reader-environment.js";
import { afterEach, expect, test, vi } from "vitest";
import { opencodeListModels, projectOpencodeModels } from "../../packages/oar/src/runtimes/opencode/list-models.js";
import type { spawnLineProcess } from "../../packages/oar/src/shared/executable/index.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";
import type { ExecutableRunner } from "../../packages/oar/src/shared/executable/run.js";

// The shape of `opencode models --verbose` (1.18.30, cli/cmd/models.ts): a
// `provider/model` line, then `JSON.stringify(model, null, 2)`. Fields
// trimmed to the ones the projection reads, plus one nested object so a
// closing brace inside the body is not taken for the model's end.
function block(id: string, model: object): string {
  return `${id}\n${JSON.stringify(model, null, 2)}\n`;
}

test("each model keeps its provider/model id, its name, and its variants as effort levels", () => {
  const stdout = [
    block("opencode/big-pickle", { id: "big-pickle", providerID: "opencode", name: "Big Pickle", limit: { context: 200_000 }, variants: { default: {} } }),
    block("anthropic/claude-haiku-4-5", {
      id: "claude-haiku-4-5",
      providerID: "anthropic",
      name: "Claude Haiku 4.5 (latest)",
      variants: { default: {}, high: { thinking: { type: "enabled", budgetTokens: 16_000 } }, max: { thinking: { type: "enabled", budgetTokens: 31_999 } } },
    }),
  ].join("");
  expect(projectOpencodeModels(stdout)).toEqual([
    { id: "opencode/big-pickle", displayName: "Big Pickle", provider: { id: "opencode" } },
    { id: "anthropic/claude-haiku-4-5", displayName: "Claude Haiku 4.5 (latest)", effortLevels: ["high", "max"], provider: { id: "anthropic" } },
  ]);
});

test("the plain listing and stray output yield no entry without a model body", () => {
  expect(projectOpencodeModels("opencode/big-pickle\nopencode/fledge-alpha-free\n")).toEqual([]);
  expect(projectOpencodeModels("Models cache refreshed\n")).toEqual([]);
  expect(projectOpencodeModels("")).toEqual([]);
});

const run = vi.hoisted(() => vi.fn<ExecutableRunner>());
vi.mock("../../packages/oar/src/shared/executable/run.js", () => ({ runExecutable: run }));

const spawn = vi.hoisted(() => vi.fn<typeof spawnLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", async original => ({ ...await original<object>(), spawnLineProcess: spawn }));
const installation = { kind: "available", via: "executable", command: "opencode", version: "2.1.4" } as const;
const ok = (data: unknown): Response => Response.json({ data });

function server() {
  const child = fakeLineProcess();
  spawn.mockImplementation(() => {
    queueMicrotask(() => { child.emit('{"url":"http://127.0.0.1:43210"}\n'); });
    return child;
  });
  const request = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", request);
  return { child, request };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); run.mockReset(); spawn.mockReset(); });

// oxlint-disable-next-line max-statements -- Check the version, launch, scoped HTTP exchange and cleanup of one listing.
test("a scoped v2 server reads the full catalog once after cold plugin startup", async () => {
  const { child, request } = server();
  const cwd = resolve("project +%");
  run.mockResolvedValueOnce({ ok: true, stdout: "2.1.4", stderr: "", exitCode: 0 });
  request.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok([{}])).mockResolvedValueOnce(ok([
    { providerID: "other", id: "other", name: "Plain", variants: [{ id: "default" }] },
    { providerID: "first", id: "nested/model", name: "Reasoner", variants: [{ id: "low" }, { id: "default" }, { id: "high" }] },
    { providerID: "other", id: "empty", variants: [] },
    { providerID: "other", id: "nullable", variants: null },
  ]));
  const answer = await opencodeListModels({ kind: "available", via: "executable", command: "opencode" }, { cwd, env: { ...readerEnvironment(), OPENCODE_DISABLE_MODELS_FETCH: "0" } });
  expect(answer).toEqual({ kind: "ok", models: [
    { id: "first/nested/model", displayName: "Reasoner", provider: { id: "first" }, effortLevels: ["low", "high"] },
    { id: "other/empty", provider: { id: "other" } },
    { id: "other/nullable", provider: { id: "other" } },
    { id: "other/other", displayName: "Plain", provider: { id: "other" } },
  ] });
  expect(run.mock.calls.map(call => call[1])).toEqual([["--version"]]);
  expect(spawn.mock.calls.map(call => call[1])).toEqual([["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"]]);
  for (const launch of [run.mock.calls[0]?.[2], spawn.mock.calls[0]?.[2]]) {
    expectReaderEnvironment(launch?.env);
    expect(launch?.cwd).toBe(cwd);
    expect(launch?.env?.OPENCODE_DISABLE_MODELS_FETCH).toBe("0");
  }
  expect(request.mock.calls.map(([url]) => typeof url === "string" ? new URL(url).pathname : undefined)).toEqual(["/api/plugin", "/api/plugin", "/api/model"]);
  for (const [, init] of request.mock.calls) {
    expect(init?.method ?? "GET").toBe("GET");
    expect(new Headers(init?.headers).get("x-opencode-directory")).toBe(encodeURIComponent(cwd));
  }
  expect(child.killed()).toBe(true);
});

test("the private model server applies the serve guards and preserves an unset model-fetch policy", async () => {
  const { request } = server();
  request.mockResolvedValueOnce(ok([{}])).mockResolvedValueOnce(ok([]));
  await opencodeListModels(installation, { env: {
    OPENCODE_DISABLE_MODELS_FETCH: null, OPENCODE_DISABLE_AUTOUPDATE: "0", BROWSER: "fixture-browser",
    OPENCODE_SERVER_USERNAME: "fixture-user", OPENCODE_PASSWORD: "fixture-primary", OPENCODE_SERVER_PASSWORD: "fixture-fallback",
  } });
  const env = spawn.mock.calls[0]?.[2]?.env;
  expect(env?.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
  expect(Object.hasOwn(env ?? {}, "OPENCODE_DISABLE_MODELS_FETCH")).toBe(false);
  expect(env?.OPENCODE_SERVER_USERNAME).toBeUndefined();
  expect(env?.BROWSER).toBe(process.platform === "win32" ? "fixture-browser" : "true");
  const password = env?.OPENCODE_PASSWORD;
  expect(typeof password === "string" && password.length > 0 && password !== "fixture-primary" && password !== "fixture-fallback" && password === env?.OPENCODE_SERVER_PASSWORD).toBe(true);
});

test("an empty native snapshot cannot establish that there are no models", async () => {
  const { child, request } = server();
  request.mockResolvedValueOnce(ok([{}])).mockResolvedValueOnce(ok([]));
  expect(await opencodeListModels(installation)).toEqual({ kind: "unsupported", reason: "OpenCode returned an empty model snapshot before catalog readiness could be established" });
  expect(child.killed()).toBe(true);
});

test.each([
  { response: () => new Response("private details", { status: 503 }), error: "OpenCode discovery /api/model failed (HTTP 503)" },
  { response: () => ok([{ id: "model", variants: [] }]), error: "OpenCode model catalog contains an invalid identifier" },
  { response: () => ok([{ id: "model", providerID: "p", variants: [null] }]), error: "Native inventory entry is not an object" },
])("a failed catalog read joins server cleanup: $error", async ({ response, error }) => {
  const { child, request } = server();
  request.mockResolvedValueOnce(ok([{}])).mockResolvedValueOnce(response());
  await expect(opencodeListModels(installation)).rejects.toThrow(error);
  expect(child.killed()).toBe(true);
});

// oxlint-disable-next-line max-statements -- Observe one deadline across the version probe, HTTP read and cleanup.
test("version detection, plugin startup and the bulk model request share one deadline", async () => {
  vi.useFakeTimers();
  const { child, request } = server();
  run.mockImplementation(async () => {
    const probe = Promise.withResolvers<void>();
    setTimeout(probe.resolve, 50);
    await probe.promise;
    return { ok: true, exitCode: 0, stdout: "2.4.1", stderr: "" };
  });
  request.mockResolvedValueOnce(ok([{}])).mockReturnValueOnce(Promise.withResolvers<Response>().promise);
  const deadline = expect(opencodeListModels({ kind: "available", via: "executable", command: "opencode" }, { timeoutMs: 100 })).rejects.toThrow("OpenCode model listing timed out");
  await vi.advanceTimersByTimeAsync(99);
  expect(request).toHaveBeenCalledTimes(2);
  expect(child.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await deadline;
  expect(request.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  expect(child.killed()).toBe(true);
});
