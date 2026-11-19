import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { promptAndWait, qwenRuntime } from "../../packages/oar/src/index.js";
import { QWEN_DEFAULTS_PREFIX } from "../../packages/oar/src/runtimes/qwen/native-memory.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startQwenAimock } from "../harness/qwen-aimock.js";
import type { Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";

async function open(env: Awaited<ReturnType<typeof startQwenAimock>>, options: Omit<SessionOptions, "cwd"> = {}, extraEnv: Record<string, string> = {}): Promise<Session> {
  const installation = await qwenRuntime.installation();
  if (installation.kind !== "available") { throw new Error(`Qwen missing: ${JSON.stringify(installation)}`); }
  return qwenRuntime.session(installation, { ...options, cwd: env.cwd, env: { ...env.env, ...extraEnv } });
}

async function turn(session: Session, input: string): Promise<void> {
  const result = await promptAndWait(session, input, { timeoutMs: 45_000 });
  expect(result.kind).toBe("ended");
  if (result.kind !== "ended") { throw new Error(JSON.stringify(result)); }
  expect(result.outcome).toEqual({ kind: "completed" });
}

async function ownDefaultsDirs(): Promise<readonly string[]> {
  const prefix = `${QWEN_DEFAULTS_PREFIX}${String(process.pid)}-`;
  const entries = await readdir(tmpdir());
  return entries.filter((name) => name.startsWith(prefix));
}

describe.skipIf(process.env.OAR_TEST !== "qwen-aimock")("Qwen nativeMemoryDefault and nativeMemory readback", () => {
  test("nativeMemoryDefault: 'off' disables default auto-memory, avoids background extraction, and cleans up its temp dir", async () => {
    const env = await startQwenAimock();
    try {
      const session = await open(env, { nativeMemoryDefault: "off" });
      try {
        expect(session.capabilities.nativeMemory).toBe("off");
        await turn(session, "remember that my favorite color is chartreuse");
        await turn(session, "what is 2 + 2");
      } finally { await session.dispose(); }
      expect(env.raw).toHaveLength(2);
      expect(JSON.stringify(env.raw)).not.toContain("# Current auto-memory catalog");
      expect(await ownDefaultsDirs()).toEqual([]);
    } finally { await env.stop(); }
  }, 90_000);

  test("user settings enabling auto-memory override nativeMemoryDefault: 'off' and report nativeMemory: 'on'", async () => {
    const env = await startQwenAimock();
    const settingsPath = path.join(env.env.HOME ?? "", ".qwen", "settings.json");
    const existing = asRecord(JSON.parse(await readFile(settingsPath, "utf8")));
    await writeFile(settingsPath, JSON.stringify({ ...existing, memory: { enableManagedAutoMemory: true } }));
    try {
      const session = await open(env, { nativeMemoryDefault: "off" });
      try {
        expect(session.capabilities.nativeMemory).toBe("on");
        await turn(session, "hello from user-enabled memory");
      } finally { await session.dispose(); }
      expect(JSON.stringify(env.raw)).toContain("# Current auto-memory catalog");
      expect(await ownDefaultsDirs()).toEqual([]);
    } finally { await env.stop(); }
  }, 90_000);

  test("merges an existing QWEN_CODE_SYSTEM_DEFAULTS_PATH without mutating it", async () => {
    const env = await startQwenAimock();
    const defaultsPath = path.join(env.cwd, "existing-system-defaults.json");
    const original = `${JSON.stringify({ ui: { theme: "dark" }, memory: { enableManagedAutoMemory: true } }, null, 2)}\n`;
    await writeFile(defaultsPath, original, "utf8");
    try {
      const session = await open(env, { nativeMemoryDefault: "off" }, { QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaultsPath });
      try {
        expect(session.capabilities.nativeMemory).toBe("off");
        await turn(session, "check merged defaults");
      } finally { await session.dispose(); }
      expect(await readFile(defaultsPath, "utf8")).toBe(original);
      expect(env.raw).toHaveLength(1);
      expect(JSON.stringify(env.raw)).not.toContain("# Current auto-memory catalog");
      expect(await ownDefaultsDirs()).toEqual([]);
    } finally { await env.stop(); }
  }, 90_000);
});
