import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { antigravitySilentAuthEnv, clearAntigravityPlanCache } from "../../packages/oar/src/runtimes/antigravity/account.js";
import {
  ANTIGRAVITY_DISABLE_AUTO_UPDATE_ENV,
  antigravityEnvOverlay,
  antigravityEnvironment,
} from "../../packages/oar/src/runtimes/antigravity/environment.js";
import { antigravityRuntime } from "../../packages/oar/src/runtimes/antigravity/index.js";
import type { SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { clearInstallationCache } from "../../packages/oar/src/shared/installation.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";

interface RecordedSpawn {
  readonly args: readonly string[];
  readonly autoUpdate: string | null;
  readonly hasAutoUpdate: boolean;
}

const FAKE_AGY_SCRIPT = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const logFile = process.env.FAKE_AGY_ENV_LOG;
if (logFile) {
  appendFileSync(logFile, JSON.stringify({
    args,
    autoUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null,
    hasAutoUpdate: Object.hasOwn(process.env, "AGY_CLI_DISABLE_AUTO_UPDATE"),
  }) + "\\n");
}
const vFile = process.env.FAKE_AGY_VERSION_FILE;
const ver = () => (vFile ? readFileSync(vFile, "utf8").trim() : "1.5.18");
if (args.includes("--help")) {
  process.stdout.write("Usage of antigravity-cli\\n  --conversation\\n  --print-timeout\\nStart the Agent Client Protocol (ACP) stdio server\\n");
  process.exit(0);
}
if (args.includes("--version")) { process.stdout.write(ver() + "\\n"); process.exit(0); }
if (args[0] === "models") { process.stdout.write("gemini-3.8-flash\\n"); process.exit(0); }
if (args[0] === "update") { if (vFile) { writeFileSync(vFile, "9.9.9\\n"); } process.exit(0); }
if (args[0] === "-p" && args[1] === "/usage") {
  process.stdout.write(JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [{ name: "Gemini Models", buckets: [{ id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.9, reset_time: "2026-11-27T00:00:00Z" }] }] } } }) + "\\n");
  process.exit(0);
}
if (args[0] === "--output-format" && args[1] === "json" && args[2] === "--print=/skills") {
  process.stdout.write(JSON.stringify({ status: "SUCCESS", conversation_id: "", num_turns: 0, command: { name: "skills", data: { skills: [] } } }) + "\\n");
  process.exit(0);
}
if (args[0] === "acp" && args.includes("--login")) {
  process.stdout.write("Open this link in a browser to log in with Google:\\nhttps://accounts.google.com/o/oauth2/auth?client_id=synthetic\\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\\n");
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.once("line", () => { rl.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
} else if (args[0] === "acp") {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) { return; }
    const msg = JSON.parse(line);
    if (msg.id === undefined) { return; }
    let result = {};
    if (msg.method === "initialize") {
      result = { protocolVersion: 1, agentCapabilities: { auth: { logout: {} }, _meta: { antigravity: { tier: true } } }, authMethods: [{ id: "oauth-personal", name: "OAuth" }] };
    } else if (msg.method === "authenticate") {
      result = { _meta: { antigravity: { tier: { name: "Google AI Pro" } } } };
    } else if (msg.method === "session/new" || msg.method === "session/set_config_option") {
      result = { sessionId: "fake-agy-session", configOptions: [{ id: "model", name: "Model", category: "model", currentValue: "gemini-3.8-flash", options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }] }] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  });
} else { process.exit(2); }
`;

const tempDirs: string[] = [];
const ORIGINAL_UPPER = process.env.AGY_CLI_DISABLE_AUTO_UPDATE;
const ORIGINAL_LOWER = process.env.agy_cli_disable_auto_update;

function restoreEnvKey(key: string, value: string | undefined): void {
  if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
}

async function withProcessEnv(overrides: Readonly<Record<string, string>>, run: () => Promise<void>): Promise<void> {
  const saved = Object.entries(overrides).map(([key]) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(overrides)) { process.env[key] = value; }
  try { await run(); } finally { for (const [key, value] of saved) { restoreEnvKey(key, value); } }
}

function parseSpawn(line: string): RecordedSpawn {
  const row: unknown = JSON.parse(line);
  if (typeof row !== "object" || row === null || !("args" in row) || !Array.isArray(row.args) || !("autoUpdate" in row) || !("hasAutoUpdate" in row) || typeof row.hasAutoUpdate !== "boolean") {
    throw new TypeError(`Unexpected spawn log line: ${line}`);
  }
  return {
    args: row.args.filter((value): value is string => typeof value === "string"),
    autoUpdate: typeof row.autoUpdate === "string" ? row.autoUpdate : null,
    hasAutoUpdate: row.hasAutoUpdate,
  };
}

function seedFakeDir(dir: string): { readonly scriptPath: string; readonly logPath: string; readonly versionPath: string } {
  const scriptPath = path.join(dir, "fake-agy.mjs");
  const versionPath = path.join(dir, "version.txt");
  writeFileSync(scriptPath, FAKE_AGY_SCRIPT);
  writeFileSync(versionPath, "1.5.18\n");
  mkdirSync(path.join(dir, ".gemini", "antigravity-cli", "cache"), { recursive: true });
  writeFileSync(path.join(dir, ".gemini", "antigravity-cli", "cache", "acp-auth-state.json"), JSON.stringify({ methodId: "oauth-personal" }));
  return { scriptPath, logPath: path.join(dir, "spawns.jsonl"), versionPath };
}

function createFakeAgy() {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-agy-autoupdate-"));
  tempDirs.push(dir);
  const { scriptPath, logPath, versionPath } = seedFakeDir(dir);
  const command = fakeAgentBinary(dir, [scriptPath]);
  return {
    dir,
    command,
    installation: { kind: "available", via: "executable", command, version: "1.5.18" } as const,
    versionless: { kind: "available", via: "executable", command } as const,
    baseEnv: { HOME: dir, USERPROFILE: dir, FAKE_AGY_ENV_LOG: logPath, FAKE_AGY_VERSION_FILE: versionPath },
    readSpawns: (): readonly RecordedSpawn[] => {
      if (!existsSync(logPath)) { return []; }
      const content = readFileSync(logPath, "utf8").trim();
      return content === "" ? [] : content.split("\n").map((line) => parseSpawn(line));
    },
    clearSpawns: (): void => { writeFileSync(logPath, ""); },
  };
}

beforeEach(() => {
  delete process.env.AGY_CLI_DISABLE_AUTO_UPDATE;
  delete process.env.agy_cli_disable_auto_update;
  clearInstallationCache();
  clearAntigravityPlanCache();
});

afterEach(() => {
  restoreEnvKey("AGY_CLI_DISABLE_AUTO_UPDATE", ORIGINAL_UPPER);
  restoreEnvKey("agy_cli_disable_auto_update", ORIGINAL_LOWER);
  vi.restoreAllMocks();
  clearInstallationCache();
  clearAntigravityPlanCache();
  for (const dir of tempDirs.splice(0)) { rmSync(dir, { recursive: true, force: true }); }
});

interface OverlayCase {
  readonly label: string;
  readonly overlay: SessionOptions["env"];
  readonly inherited: Readonly<NodeJS.ProcessEnv>;
  readonly platform: NodeJS.Platform;
  readonly expected: SessionOptions["env"];
}

test.each<OverlayCase>([
  { label: "unset overlay defaults true", overlay: undefined, inherited: {}, platform: "linux", expected: { [ANTIGRAVITY_DISABLE_AUTO_UPDATE_ENV]: "true" } },
  { label: "overlay merges other vars", overlay: { FOO: "bar" }, inherited: {}, platform: "linux", expected: { FOO: "bar", [ANTIGRAVITY_DISABLE_AUTO_UPDATE_ENV]: "true" } },
  { label: "explicit false override wins", overlay: { AGY_CLI_DISABLE_AUTO_UPDATE: "false" }, inherited: {}, platform: "linux", expected: { AGY_CLI_DISABLE_AUTO_UPDATE: "false" } },
  { label: "explicit null removal stays intact", overlay: { AGY_CLI_DISABLE_AUTO_UPDATE: null }, inherited: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" }, platform: "linux", expected: { AGY_CLI_DISABLE_AUTO_UPDATE: null } },
  { label: "inherited value suppresses default", overlay: undefined, inherited: { AGY_CLI_DISABLE_AUTO_UPDATE: "0" }, platform: "linux", expected: undefined },
  { label: "win32 overlay ignores case", overlay: { agy_cli_disable_auto_update: "false" }, inherited: {}, platform: "win32", expected: { agy_cli_disable_auto_update: "false" } },
  { label: "win32 inherited ignores case", overlay: undefined, inherited: { agy_cli_disable_auto_update: "false" }, platform: "win32", expected: undefined },
])("antigravityEnvOverlay: $label", ({ overlay, inherited, platform, expected }) => {
  expect(antigravityEnvOverlay(overlay, inherited, platform)).toEqual(expected);
});

test("antigravityEnvironment strips both casings on explicit null and preserves antigravitySilentAuthEnv default", () => {
  const linux = antigravityEnvironment({ AGY_CLI_DISABLE_AUTO_UPDATE: null }, { AGY_CLI_DISABLE_AUTO_UPDATE: "1" }, "linux");
  expect(Object.hasOwn(linux, "AGY_CLI_DISABLE_AUTO_UPDATE")).toBe(false);
  const win = antigravityEnvironment({ agy_cli_disable_auto_update: null }, { AGY_CLI_DISABLE_AUTO_UPDATE: "1" }, "win32");
  expect(Object.hasOwn(win, "AGY_CLI_DISABLE_AUTO_UPDATE") || Object.hasOwn(win, "agy_cli_disable_auto_update")).toBe(false);
  expect(antigravitySilentAuthEnv({}).AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
  expect(antigravitySilentAuthEnv({ AGY_CLI_DISABLE_AUTO_UPDATE: "false" }).AGY_CLI_DISABLE_AUTO_UPDATE).toBe("false");
});

interface ProbeCase {
  readonly label: string;
  readonly extra: SessionOptions["env"];
  readonly expectedValue: string | null;
  readonly expectedHas: boolean;
}

test.each<ProbeCase>([
  { label: "default", extra: undefined, expectedValue: "true", expectedHas: true },
  { label: "explicit false", extra: { AGY_CLI_DISABLE_AUTO_UPDATE: "false" }, expectedValue: "false", expectedHas: true },
  { label: "explicit null", extra: { AGY_CLI_DISABLE_AUTO_UPDATE: null }, expectedValue: null, expectedHas: false },
])("installation probe honors $label", async ({ extra, expectedValue, expectedHas }) => {
  const fake = createFakeAgy();
  clearInstallationCache();
  await antigravityRuntime.installation({ env: { ...fake.baseEnv, OAR_ANTIGRAVITY_BIN: fake.command, ...extra } });
  expect(fake.readSpawns().every((row) => row.hasAutoUpdate === expectedHas && row.autoUpdate === expectedValue)).toBe(true);
});

test("accountUsage defaults true across preflight, models, acp tier, and /usage", async () => {
  const fake = createFakeAgy();
  expect(await antigravityRuntime.accountUsage(fake.versionless, { env: fake.baseEnv })).toEqual({ kind: "unsupported", reason: "print_mode_disabled" });
  expect(fake.readSpawns()).toEqual([]);
  const usage = await antigravityRuntime.accountUsage(fake.versionless, { env: fake.baseEnv, allowPrintMode: true });
  expect(usage.kind).toBe("available");
  expect(fake.readSpawns().map((row) => row.args[0])).toEqual(["--version", "models", "acp", "-p"]);
  expect(fake.readSpawns().every((row) => row.autoUpdate === "true")).toBe(true);
});

test("authStatus honors explicit null across preflight, models, and acp tier check", async () => {
  const fake = createFakeAgy();
  const status = await antigravityRuntime.authStatus(fake.versionless, { env: { ...fake.baseEnv, AGY_CLI_DISABLE_AUTO_UPDATE: null } });
  expect(status).toMatchObject({ kind: "logged_in", account: { plan: "Google AI Pro" } });
  expect(fake.readSpawns().map((row) => row.args[0])).toEqual(["--version", "models", "acp"]);
  expect(fake.readSpawns().every((row) => !row.hasAutoUpdate)).toBe(true);
});

test("listModels defaults true and honors explicit null", async () => {
  const fake = createFakeAgy();
  await expect(antigravityRuntime.listModels(fake.versionless, { cwd: fake.dir, env: fake.baseEnv })).resolves.toMatchObject({ kind: "ok" });
  expect(fake.readSpawns().every((row) => row.autoUpdate === "true")).toBe(true);
  fake.clearSpawns();
  await antigravityRuntime.listModels(fake.versionless, { cwd: fake.dir, env: { ...fake.baseEnv, AGY_CLI_DISABLE_AUTO_UPDATE: null } });
  expect(fake.readSpawns().every((row) => !row.hasAutoUpdate)).toBe(true);
});

test("skills keeps forcing true when allowPrintMode runs the native fallback", async () => {
  const fake = createFakeAgy();
  expect(await antigravityRuntime.skills({ ...fake.installation, version: "1.5.5" }, { cwd: fake.dir, env: fake.baseEnv })).toMatchObject({ kind: "unsupported", code: "print_mode_disabled" });
  expect(fake.readSpawns()).toEqual([]);
  const skills = await antigravityRuntime.skills({ ...fake.installation, version: "1.5.5" }, { cwd: fake.dir, env: { ...fake.baseEnv, AGY_CLI_DISABLE_AUTO_UPDATE: "false" }, allowPrintMode: true });
  expect(skills.kind).toBe("ok");
  expect(fake.readSpawns().every((row) => row.autoUpdate === "true")).toBe(true);
});

test("login and logout propagate default and explicit overrides", async () => {
  const fake = createFakeAgy();
  await expect(antigravityRuntime.login(fake.installation, { onEvent: () => {}, prompt: async () => "code" }, { env: fake.baseEnv })).resolves.toMatchObject({ kind: "logged_in" });
  expect(fake.readSpawns().every((row) => row.autoUpdate === "true")).toBe(true);
  fake.clearSpawns();
  await expect(antigravityRuntime.logout(fake.installation, { env: { ...fake.baseEnv, AGY_CLI_DISABLE_AUTO_UPDATE: "false" } })).resolves.toMatchObject({ kind: "failed", reason: "still_logged_in" });
  expect(fake.readSpawns().map((row) => row.args[0])).toEqual(["acp", "models"]);
  expect(fake.readSpawns().every((row) => row.autoUpdate === "false")).toBe(true);
});

test("session propagates default true and honors explicit false override", async () => {
  const fake = createFakeAgy();
  const session = await antigravityRuntime.session(fake.installation, { cwd: fake.dir, env: fake.baseEnv });
  await session.dispose();
  expect(fake.readSpawns().every((row) => row.autoUpdate === "true")).toBe(true);
  fake.clearSpawns();
  const custom = await antigravityRuntime.session(fake.installation, { cwd: fake.dir, env: { ...fake.baseEnv, AGY_CLI_DISABLE_AUTO_UPDATE: "false" } });
  await custom.dispose();
  expect(fake.readSpawns().every((row) => row.autoUpdate === "false")).toBe(true);
});

test("upgrade leaves AGY_CLI_DISABLE_AUTO_UPDATE unset unless provided by host", async () => {
  const fake = createFakeAgy();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ version: "9.9.9" }));
  await withProcessEnv({ FAKE_AGY_ENV_LOG: fake.baseEnv.FAKE_AGY_ENV_LOG, FAKE_AGY_VERSION_FILE: fake.baseEnv.FAKE_AGY_VERSION_FILE }, async () => {
    expect(await antigravityRuntime.upgrade(fake.installation)).toMatchObject({ kind: "upgraded", from: "1.5.18", to: "9.9.9" });
    expect(fake.readSpawns().find((row) => row.args[0] === "update")?.hasAutoUpdate).toBe(false);
  });
});
