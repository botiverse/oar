// oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers are intentionally untyped.
import { spawn, execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { orient, RuntimeRegistry } from "../../packages/oar/src/index.js";
import { qwenRuntime } from "../../packages/oar/src/runtimes/qwen/index.js";
import qwenAuthHome from "../fixtures/qwen-auth-home.js";

vi.mock("node:child_process", async (original) => ({ ...await original<object>(), spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<{ readFile: typeof readFile; stat: typeof stat }>();
  return { ...fs, readFile: vi.fn(fs.readFile), stat: vi.fn(fs.stat) };
});
const installation = { kind: "available", via: "executable", command: "must-not-be-started", version: "0.26.2" } as const;
const SECRET = "synthetic-private-credential-must-never-leak";
// oxlint-disable-next-line init-declarations -- Each test gets its own isolated HOME in beforeEach.
let fixture: Awaited<ReturnType<typeof qwenAuthHome>>;
beforeEach(async () => { fixture = await qwenAuthHome(); vi.stubGlobal("fetch", vi.fn()); });
afterEach(async () => {
  expect(spawn).not.toHaveBeenCalled();
  expect(execFile).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  await fixture.dispose();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
async function status(env = fixture.env) { return qwenRuntime.authStatus(installation, { env }); }

// oxlint-disable-next-line max-statements -- Scope and absence of writes are both promises of an empty observation.
test("no user/system credential is logged out with workspace caveat, without creating configuration", async () => {
  const result = await status();
  expect(result).toMatchObject({ kind: "logged_out", detail: expect.stringContaining("Project settings, workspace .env files and launch arguments may still supply credentials") });
  expect(result).toHaveProperty("detail", expect.stringContaining("OPENAI_API_KEY"));
  expect(await fixture.snapshot()).toEqual([]);
  expect(qwenRuntime.authStatus.localOnly).toBe(true);
  expect(qwenRuntime).not.toHaveProperty("login");
  expect(qwenRuntime).not.toHaveProperty("logout");
});

test.each(["OPENAI_API_KEY", "BAILIAN_CODING_PLAN_API_KEY", "BAILIAN_TOKEN_PLAN_API_KEY", "OPENROUTER_API_KEY", "REQUESTY_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"])("%s is presence evidence, never a validated login", async (key) => {
  const result = await status({ ...fixture.env, [key]: SECRET });
  expect(result).toMatchObject({ kind: "unknown", detail: expect.stringContaining(`environment: ${key}`) });
  expect(result).not.toHaveProperty("account");
  expect(JSON.stringify(result)).not.toContain(SECRET);
});

test("the overlay inherits, replaces and removes a key without changing the host", async () => {
  vi.stubEnv("OPENAI_API_KEY", SECRET);
  const { OPENAI_API_KEY: _ignored, ...inherited } = fixture.env;
  expect(await status(inherited)).toHaveProperty("kind", "unknown");
  expect(await status({ ...inherited, OPENAI_API_KEY: null })).toHaveProperty("kind", "logged_out");
  expect(await status({ ...inherited, OPENAI_API_KEY: "replacement" })).toHaveProperty("kind", "unknown");
  expect(process.env.OPENAI_API_KEY).toBe(SECRET);
});

test.each([".qwen/settings.json", "system/settings.json", "system/system-defaults.json"])("reads %s JSONC without migration or secret-bearing output", async (file) => {
  await fixture.write(file, `\uFEFF{ // native JSONC\n"security":{"auth":{"selectedType":"openai","apiKey":"${SECRET}"}}}`);
  const before = await fixture.snapshot();
  const result = await status();
  expect(result).toMatchObject({ kind: "unknown", detail: expect.stringContaining("security.auth.apiKey (openai)") });
  expect(JSON.stringify(result)).not.toContain(SECRET);
  expect(await fixture.snapshot()).toEqual(before);
});

test("custom modelProviders envKey resolves from settings.env and does not validate the selected model", async () => {
  await fixture.write(".qwen/settings.json", { $version: 4, security: { auth: { selectedType: "anthropic" } }, modelProviders: { openai: [{ id: "custom-model", envKey: "MY_PROVIDER_KEY" }] }, env: { MY_PROVIDER_KEY: SECRET } });
  expect(await status()).toMatchObject({ kind: "unknown", detail: expect.stringContaining("MY_PROVIDER_KEY") });
});

test("an unset custom key and a selected API-key auth type alone are not credentials", async () => {
  await fixture.write(".qwen/settings.json", { security: { auth: { selectedType: "openai" } }, modelProviders: { openai: [{ id: "model", envKey: "MY_EMPTY_KEY" }] }, env: { MY_EMPTY_KEY: "" } });
  expect(await status()).toHaveProperty("kind", "logged_out");
});

test.each([".qwen/.env", ".env"])("user %s supplies quoted keys even after the inherited key is removed", async (file) => {
  await fixture.write(file, `export OPENAI_API_KEY='${SECRET} # literal in quotes'\n`);
  expect(await status({ ...fixture.env, OPENAI_API_KEY: null })).toMatchObject({ kind: "unknown", detail: expect.stringContaining("user .env or settings.env: OPENAI_API_KEY") });
});

test("QWEN_HOME from user .env redirects settings and preserves the legacy user dotenv source", async () => {
  await fixture.write(".env", "QWEN_HOME=~/redirected\n");
  await fixture.write("redirected/settings.json", { modelProviders: { openai: [{ envKey: "LEGACY_KEY" }] } });
  await fixture.write(".qwen/.env", `LEGACY_KEY=${SECRET}`);
  expect(await status()).toMatchObject({ kind: "unknown", detail: expect.stringContaining("LEGACY_KEY") });
  expect(await status({ ...fixture.env, QWEN_HOME: "" })).toHaveProperty("kind", "logged_out");
});

test("project settings and workspace dotenv stay outside the machine/user observation", async () => {
  await fixture.write("project/.qwen/settings.json", { security: { auth: { apiKey: SECRET } } });
  await fixture.write("project/.env", `OPENAI_API_KEY=${SECRET}`);
  vi.spyOn(process, "cwd").mockReturnValue(path.join(fixture.home, "project"));
  expect(await status()).toHaveProperty("kind", "logged_out");
});

test.each(["vertex-ai", "qwen-oauth"])("%s selection may use external credentials and remains unknown", async (selectedType) => {
  await fixture.write(".qwen/settings.json", { selectedAuthType: selectedType });
  expect(await status()).toMatchObject({ kind: "unknown", detail: expect.stringContaining(selectedType) });
});

test("ADC and legacy OAuth files are checked for existence without reading their contents", async () => {
  const adc = await fixture.write(process.platform === "win32" ? "AppData/gcloud/application_default_credentials.json" : ".config/gcloud/application_default_credentials.json", SECRET);
  const oauth = await fixture.write(".qwen/oauth_creds.json", SECRET);
  vi.mocked(readFile).mockClear();
  const result = await status();
  expect(result).toMatchObject({ kind: "unknown", detail: expect.stringContaining("Vertex ADC file exists") });
  expect(result).toHaveProperty("detail", expect.stringContaining("legacy Qwen OAuth credential file exists"));
  expect(vi.mocked(readFile).mock.calls.map(([file]) => file)).not.toContain(adc);
  expect(vi.mocked(readFile).mock.calls.map(([file]) => file)).not.toContain(oauth);
});

test("an explicit ADC path is metadata-only; a missing file or metadata-based ADC is still unknown", async () => {
  const adc = await fixture.write("credential.json", SECRET);
  expect(await status({ ...fixture.env, GOOGLE_APPLICATION_CREDENTIALS: adc })).toHaveProperty("detail", expect.stringContaining("GOOGLE_APPLICATION_CREDENTIALS file exists"));
  expect(await status({ ...fixture.env, GOOGLE_APPLICATION_CREDENTIALS: `${adc}-missing` })).toHaveProperty("detail", expect.stringContaining("file not found"));
  expect(await status({ ...fixture.env, GOOGLE_CLOUD_PROJECT: "synthetic-project" })).toHaveProperty("kind", "unknown");
});

test.each([`{"apiKey":"${SECRET}", broken`, '{"$version":99}', "[]"])("unreadable configuration stays unknown with no native detail (%#)", async (content) => {
  await fixture.write(".qwen/settings.json", content);
  const result = await status();
  expect(result).toMatchObject({ kind: "unknown", detail: expect.stringContaining("could not be completely inspected") });
  expect(JSON.stringify(result)).not.toContain(SECRET);
});

test("file metadata stalls obey the reader deadline", async () => {
  vi.useFakeTimers();
  vi.mocked(stat).mockImplementationOnce(async () => Promise.withResolvers<never>().promise);
  const pending = qwenRuntime.authStatus(installation, { env: fixture.env, timeoutMs: 10 });
  await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toMatchObject({ kind: "unknown", detail: expect.stringContaining("timed out") });
});

test("local orient includes the declared Qwen reader without model or account requests", async () => {
  const report = await orient(new RuntimeRegistry([{ ...qwenRuntime, installation: async () => installation }]), { env: { ...fixture.env, OPENAI_API_KEY: SECRET } });
  expect(report.runtimes[0]?.auth).toMatchObject({ kind: "ok", value: { kind: "unknown", detail: expect.stringContaining("OPENAI_API_KEY") } });
  expect(JSON.stringify(report)).not.toContain(SECRET);
});
