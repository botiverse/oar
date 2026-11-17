import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { kimiRuntime } from "../../packages/oar/src/runtimes/kimi/index.js";
import { parseJson, asRecord } from "../../packages/oar/src/shared/json.js";
import { resolveRunDir } from "../harness/trace.js";
import { kimiExpiredUsageFixture } from "./support/kimi-expired-usage.js";

const command = process.env.OAR_KIMI_LOGIN_COMMAND ?? "kimi";
const installation = { kind: "available", via: "executable", command, version: "2.4.1" } as const;
const windows = process.platform === "win32";
/** Only OAR's fixed error labels are retained, never native errors or response bodies. */
function failureMessages(error: unknown): string[] {
  const labels = new Set(["Failed to read Kimi account usage", "Kimi discovery HTTP failure", "Kimi native usage query failed", "Kimi account usage timed out", "Kimi discovery stopped", "Kimi discovery exited", "Kimi Web request failed"]);
  const result: string[] = [];
  for (let current = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    result.push(labels.has(current.message) ? current.message : "unclassified error");
  }
  return result;
}

async function stopped(trace: string): Promise<void> {
  const content = await readFile(trace, "utf8");
  const rows = content.trim().split("\n");
  for (const row of rows) {
    const pid = asRecord(parseJson(row))?.pid;
    if (typeof pid === "number") { await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, { timeout: 15_000 }).toBe(true); }
  }
}
describe.skipIf(process.env.OAR_TEST !== "kimi-login")("Kimi native expired-token usage", () => {
  test.each([1, 2])("%s concurrent readers leave credential refresh to native locking", { timeout: 60_000 }, async count => {
    const f = await kimiExpiredUsageFixture("success");
    const pending = Array.from({ length: count }, async () => kimiRuntime.accountUsage(installation, { env: f.env, timeoutMs: 30_000 }));
    const outcomes = Promise.allSettled(pending);
    try {
      const results = await Promise.all(pending);
      if (windows) {
        expect(results).toEqual(Array.from({ length: count }, () => ({ kind: "unavailable", reason: "access_token_expired" })));
        expect(f.calls).toHaveLength(0); expect(await readFile(f.file, "utf8")).toBe(f.before);
      } else {
        for (const result of results) { expect(result).toMatchObject({ kind: "available", displayName: "Fixture", rateLimited: false, windows: [{ label: "Weekly limit", usedRatio: 0.25 }] }); }
        expect(f.calls.filter(call => call.path === "/api/oauth/token")).toHaveLength(1);
        expect(f.calls.filter(call => call.path === "/usages").every(call => call.fresh)).toBe(true);
        const token = asRecord(parseJson(await readFile(f.file, "utf8"))); expect(token?.access_token).toBe("synthetic-fresh");
      }
    } finally {
      try {
        const settled = await outcomes;
        try {
          const dir = path.join(resolveRunDir(), "kimi-expired-usage"); await mkdir(dir, { recursive: true });
          await writeFile(path.join(dir, `concurrent-${String(count)}.json`), JSON.stringify({ platform: process.platform, count,
            outcomes: settled.map(result => result.status === "fulfilled" ? result : { status: result.status, errors: failureMessages(result.reason) }),
            observation: await f.observe() }, null, 2));
        } catch (error) {
          console.error("Kimi usage evidence could not be saved:", error instanceof Error ? error.name : "unknown");
        }
        await stopped(f.trace);
      } finally { await f.dispose(); }
    }
  });
  test("skill discovery leaves expired OAuth untouched before a later usage read", { timeout: 60_000 }, async () => {
    const f = await kimiExpiredUsageFixture("success");
    try {
      const config = path.join(f.home, "config.toml"); const configBefore = await readFile(config, "utf8");
      const env = { ...f.env, KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: "1", KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: "1" };
      const skills = await kimiRuntime.skills(installation, { env, cwd: f.dir, timeoutMs: 30_000 });
      expect(skills.kind).toBe("ok"); expect(f.calls).toHaveLength(0);
      expect(await readFile(f.file, "utf8")).toBe(f.before);
      const result = await kimiRuntime.accountUsage(installation, { env, timeoutMs: 30_000 });
      if (windows) { expect(result).toEqual({ kind: "unavailable", reason: "access_token_expired" }); expect(f.calls).toHaveLength(0); }
      else {
        expect(result.kind).toBe("available");
        expect(f.calls.filter(call => call.path === "/api/oauth/token")).toStrictEqual([{ path: "/api/oauth/token", fresh: false, status: 200, submittedGeneration: 0, expectedGeneration: 0 }]);
        expect(await f.observe()).toMatchObject({ credential: { fresh: true, revoked: false, refreshCurrent: true, refreshEmpty: false } });
      }
      expect(await readFile(config, "utf8")).toBe(configBefore);
    } finally { await stopped(f.trace); await f.dispose(); }
  });
  test.each(["rejected", "network"] as const)("native refresh %s preserves the auth/failure distinction", { timeout: 60_000 }, async mode => {
    const f = await kimiExpiredUsageFixture(mode);
    try {
      const pending = kimiRuntime.accountUsage(installation, { env: f.env, timeoutMs: 30_000 });
      if (windows) { await expect(pending).resolves.toEqual({ kind: "unavailable", reason: "access_token_expired" }); }
      else if (mode === "rejected") {
        await expect(pending).resolves.toEqual({ kind: "reauth_required", reason: "credentials_rejected" });
        const stored = parseJson(await readFile(f.file, "utf8")); expect(asRecord(stored)?.access_token).toBe("");
      } else {
        await expect(pending).rejects.toThrow("Failed to read Kimi account usage");
        await expect(pending).rejects.not.toThrow("PRIVATE"); expect(await readFile(f.file, "utf8")).toBe(f.before);
      }
      expect(f.calls.some(call => call.path === "/usages")).toBe(false);
    } finally { await stopped(f.trace); await f.dispose(); }
  });
  test.skipIf(windows)("a native refresh timeout preserves the deadline and stops the owned processes", { timeout: 45_000 }, async () => {
    const f = await kimiExpiredUsageFixture("hang");
    try {
      await expect(kimiRuntime.accountUsage(installation, { env: f.env, timeoutMs: 15_000 })).rejects.toHaveProperty("cause.message", "Kimi account usage timed out");
      expect(f.calls.some(call => call.path === "/api/oauth/token")).toBe(true);
      expect(await readFile(f.file, "utf8")).toBe(f.before);
    } finally { await stopped(f.trace); await f.dispose(); }
  });
  test("disabling the native lock leaves the credential unchanged and makes no HTTP request", { timeout: 30_000 }, async () => {
    const f = await kimiExpiredUsageFixture("success");
    try {
      await expect(kimiRuntime.accountUsage(installation, { env: { ...f.env, KIMI_DISABLE_OAUTH_LOCK: "1" } })).resolves.toEqual({ kind: "unavailable", reason: "access_token_expired" });
      expect(f.calls).toHaveLength(0); expect(await readFile(f.file, "utf8")).toBe(f.before);
    } finally { await stopped(f.trace); await f.dispose(); }
  });
});
