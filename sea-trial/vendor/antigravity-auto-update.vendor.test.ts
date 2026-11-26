/* oxlint-disable max-statements, max-lines-per-function -- Isolated native auto-updater checks share setup and host env restoration. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { antigravityRuntime } from "../../packages/oar/src/runtimes/antigravity/index.js";
import { clearInstallationCache } from "../../packages/oar/src/shared/installation.js";
import { startAntigravityAimock } from "../harness/aimock-acp.js";

function withoutAutoUpdateEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key.toUpperCase() !== "AGY_CLI_DISABLE_AUTO_UPDATE") {
      result[key] = value;
    }
  }
  return result;
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(filePath);
      return true;
    } catch {
      // oxlint-disable-next-line eslint/no-await-in-loop -- polling for detached updater output
      await delay(50);
    }
  }
  return false;
}

describe.skipIf(process.env.OAR_TEST !== "antigravity-aimock")("Antigravity native auto-updater suppression", () => {
  test("installation, authStatus, listModels, and session suppress --bg-updater when host omits AGY_CLI_DISABLE_AUTO_UPDATE", { timeout: 60_000 }, async () => {
    const savedUpper = process.env.AGY_CLI_DISABLE_AUTO_UPDATE;
    const savedLower = process.env.agy_cli_disable_auto_update;
    delete process.env.AGY_CLI_DISABLE_AUTO_UPDATE;
    delete process.env.agy_cli_disable_auto_update;

    const f = await startAntigravityAimock(() => {});
    try {
      const home = f.env.HOME;
      assert.ok(home !== undefined);
      const agyDir = path.join(home, ".gemini", "antigravity-cli");
      const timestampPath = path.join(agyDir, "last_check.timestamp");
      await mkdir(agyDir, { recursive: true });
      await writeFile(timestampPath, "1700000000\n");
      const backdated = new Date(Date.now() - 2 * 60 * 60_000);
      await utimes(timestampPath, backdated, backdated);
      const beforeStat = await stat(timestampPath);
      const beforeMtimeMs = beforeStat.mtimeMs;

      const isolatedEnv: Record<string, string> = {
        ...withoutAutoUpdateEnv(f.env),
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(home, "no-bus")}`,
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        ALL_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1,localhost",
      };

      clearInstallationCache();
      const installation = await antigravityRuntime.installation({ env: isolatedEnv });
      assert.equal(installation.kind, "available", JSON.stringify(installation));
      assert.equal(installation.via, "executable");
      const beforeBinary = createHash("sha256").update(await readFile(installation.command)).digest("hex");

      const status = await antigravityRuntime.authStatus(installation, { env: isolatedEnv });
      expect(status.kind).toBe("logged_in");

      const models = await antigravityRuntime.listModels(installation, { cwd: home, env: isolatedEnv });
      expect(models.kind).toBe("ok");

      const session = await antigravityRuntime.session(installation, { cwd: home, env: isolatedEnv });
      await session.dispose();

      // Give any accidentally detached --bg-updater child time to touch last_check.timestamp.
      await delay(500);
      const afterStat = await stat(timestampPath);
      expect(afterStat.mtimeMs).toBe(beforeMtimeMs);
      await expect(stat(path.join(agyDir, "updater"))).rejects.toThrow();

      // Negative control: explicit null removal restores native --bg-updater trigger on authStatus.
      await antigravityRuntime.authStatus(installation, {
        env: { ...isolatedEnv, AGY_CLI_DISABLE_AUTO_UPDATE: null },
      });
      const updated = await waitForFile(path.join(agyDir, "updater", "update_status.json"), 15_000);
      expect(updated).toBe(true);
      const negativeStat = await stat(timestampPath);
      expect(negativeStat.mtimeMs).toBeGreaterThan(beforeMtimeMs);
      expect(createHash("sha256").update(await readFile(installation.command)).digest("hex")).toBe(beforeBinary);
    } finally {
      if (savedUpper === undefined) { delete process.env.AGY_CLI_DISABLE_AUTO_UPDATE; } else { process.env.AGY_CLI_DISABLE_AUTO_UPDATE = savedUpper; }
      if (savedLower === undefined) { delete process.env.agy_cli_disable_auto_update; } else { process.env.agy_cli_disable_auto_update = savedLower; }
      clearInstallationCache();
      // Let detached updater release file handles before cleaning temp home on Windows.
      await delay(150);
      await f.stop();
    }
  });
});
