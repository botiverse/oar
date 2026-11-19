import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { launchQwen } from "../../packages/oar/src/runtimes/qwen/launch.js";
import { prepareQwenNativeMemory, QWEN_DEFAULTS_PREFIX, sweepAbandonedQwenDefaults } from "../../packages/oar/src/runtimes/qwen/native-memory.js";

const roots: string[] = [];

async function fixture(): Promise<{ readonly root: string; readonly cwd: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "oar-qwen-mem-test-"));
  const cwd = path.join(root, "work");
  roots.push(root);
  await mkdir(cwd, { recursive: true });
  return { root, cwd };
}

async function writeJson(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

function baseEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(root, "system", "settings.json"),
    ...extra,
  };
}

async function assertPrivateModes(file: string): Promise<void> {
  if (process.platform === "win32") { return; }
  const [dirInfo, fileInfo] = await Promise.all([stat(path.dirname(file)), stat(file)]);
  expect([dirInfo.mode & 0o777, fileInfo.mode & 0o777]).toEqual([0o700, 0o600]);
}

afterEach(async () => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- sequential test fixture cleanup.
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("writes a private 0700/0600 system-defaults file for nativeMemoryDefault: 'off' and cleans up on release", async () => {
  const { root, cwd } = await fixture();
  const env = baseEnv(root);
  const setup = await prepareQwenNativeMemory({ cwd, nativeMemoryDefault: "off" }, env, "0.26.0");
  const defaultsFile = setup.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH ?? "";
  expect([env.QWEN_CODE_SYSTEM_DEFAULTS_PATH, setup.nativeMemory]).toEqual([undefined, "off"]);
  expect(JSON.parse(await readFile(defaultsFile, "utf8"))).toEqual({
    memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false, enableAutoSkill: false },
  });
  await assertPrivateModes(defaultsFile);
  setup.cleanup();
  setup.cleanup();
  await expect(access(path.dirname(defaultsFile))).rejects.toThrow();
});

test("merges existing JSONC system-defaults without mutating it, preserving unrelated keys", async () => {
  const { root, cwd } = await fixture();
  const existingPath = path.join(root, "system", "custom-defaults.json");
  const original = "\uFEFF{\n  // existing admin defaults\n  \"ui\": { \"theme\": \"dark\" },\n  \"memory\": { \"enableManagedAutoMemory\": true, \"customFlag\": 42 }\n}\n";
  await writeJson(existingPath, original);
  const setup = await prepareQwenNativeMemory({ cwd, nativeMemoryDefault: "off" }, baseEnv(root, { QWEN_CODE_SYSTEM_DEFAULTS_PATH: existingPath }), "0.28.0");
  try {
    expect([setup.nativeMemory, await readFile(existingPath, "utf8")]).toEqual(["off", original]);
    expect(JSON.parse(await readFile(setup.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH ?? "", "utf8"))).toEqual({
      ui: { theme: "dark" },
      memory: { customFlag: 42, enableManagedAutoMemory: false, enableManagedAutoDream: false, enableAutoSkill: false },
    });
  } finally { setup.cleanup(); }
});

test("lets user and workspace layers override nativeMemoryDefault: 'off'", async () => {
  const { root, cwd } = await fixture();
  await writeJson(path.join(root, "home", ".qwen", "settings.json"), JSON.stringify({ memory: { enableManagedAutoMemory: true } }));
  const userOn = await prepareQwenNativeMemory({ cwd, nativeMemoryDefault: "off" }, baseEnv(root), "0.26.0");
  userOn.cleanup();
  await writeJson(path.join(root, "home", ".qwen", "settings.json"), JSON.stringify({ memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false } }));
  await writeJson(path.join(cwd, ".qwen", "settings.json"), JSON.stringify({ memory: { enableAutoSkill: true } }));
  const workspaceOn = await prepareQwenNativeMemory({ cwd, nativeMemoryDefault: "off" }, baseEnv(root), "0.26.0");
  workspaceOn.cleanup();
  expect([userOn.nativeMemory, workspaceOn.nativeMemory]).toEqual(["on", "on"]);
});

test("lets system settings override user settings and reports omitted default state", async () => {
  const { root, cwd } = await fixture();
  const defaultOn = await prepareQwenNativeMemory({ cwd }, baseEnv(root), "0.26.0");
  await writeJson(path.join(root, "home", ".qwen", "settings.json"), JSON.stringify({ memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false } }));
  const userOff = await prepareQwenNativeMemory({ cwd }, baseEnv(root), "0.26.0");
  await writeJson(path.join(root, "system", "settings.json"), JSON.stringify({ memory: { enableManagedAutoDream: true } }));
  const systemOn = await prepareQwenNativeMemory({ cwd }, baseEnv(root), "0.26.0");
  expect([defaultOn.nativeMemory, defaultOn.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH, userOff.nativeMemory, systemOn.nativeMemory])
    .toEqual(["on", undefined, "off", "on"]);
});

test("omits nativeMemory when folderTrust gates workspace memory overrides, on malformed settings, or below 0.26.0", async () => {
  const { root, cwd } = await fixture();
  await writeJson(path.join(root, "home", ".qwen", "settings.json"), JSON.stringify({ security: { folderTrust: { enabled: true } } }));
  await writeJson(path.join(cwd, ".qwen", "settings.json"), JSON.stringify({ memory: { enableManagedAutoMemory: true } }));
  const trustedAmbiguous = await prepareQwenNativeMemory({ cwd, nativeMemoryDefault: "off" }, baseEnv(root), "0.26.0");
  trustedAmbiguous.cleanup();
  await writeJson(path.join(root, "home", ".qwen", "settings.json"), "{ invalid json");
  const malformed = await prepareQwenNativeMemory({ cwd }, baseEnv(root), "0.26.0");
  const oldVersion = await prepareQwenNativeMemory({ cwd }, baseEnv(root), "0.25.9");
  expect([trustedAmbiguous.nativeMemory, malformed.nativeMemory, oldVersion.nativeMemory]).toEqual([undefined, undefined, undefined]);
});

test("refuses nativeMemoryDefault: 'off' before spawning on Qwen below 0.26.0 or with unreadable version", async () => {
  await expect(launchQwen("nonexistent-qwen", "session-id", { cwd: "/work", nativeMemoryDefault: "off" }, "0.25.9"))
    .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "nativeMemoryDefault" });
  await expect(launchQwen("nonexistent-qwen", "session-id", { cwd: "/work", nativeMemoryDefault: "off" }, undefined))
    .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "nativeMemoryDefault" });
});

test("sweeps abandoned defaults directories left by dead host pids", async () => {
  const stale = await mkdtemp(path.join(tmpdir(), `${QWEN_DEFAULTS_PREFIX}999999-`));
  const live = await mkdtemp(path.join(tmpdir(), `${QWEN_DEFAULTS_PREFIX}${String(process.pid)}-`));
  try {
    await sweepAbandonedQwenDefaults();
    await expect(access(stale)).rejects.toThrow();
    await expect(access(live)).resolves.toBeUndefined();
  } finally {
    await rm(stale, { recursive: true, force: true });
    await rm(live, { recursive: true, force: true });
  }
});
