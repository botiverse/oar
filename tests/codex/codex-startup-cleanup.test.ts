import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { fakeAgentBinary, gone } from "../fixtures/process-tree.js";

const fixture = fileURLToPath(new URL("../fixtures/codex-startup.mjs", import.meta.url));
afterEach(() => { vi.unstubAllEnvs(); });

interface FailureCase {
  readonly failure: string;
  readonly options?: Partial<SessionOptions>;
  readonly reason: RegExp;
}

const failures: FailureCase[] = [
  { failure: "initialize", reason: /fixture refused initialize/u },
  { failure: "thread/start", reason: /fixture refused thread\/start/u },
  { failure: "thread/resume", options: { resume: "fixture-thread" }, reason: /fixture refused thread\/resume/u },
  { failure: "missing-thread-id", reason: /returned no thread id/u },
  { failure: "config/read", options: { disallowedTools: ["mcp__missing__tool"] }, reason: /fixture refused config\/read/u },
  { failure: "tool-preflight", options: { disallowedTools: ["mcp__missing__tool"] }, reason: /cannot identify one configured MCP server/u },
  { failure: "model-readback", options: { model: "requested-model" }, reason: /requested-model/u },
  { failure: "thread/settings/update", options: { resume: "fixture-thread", effort: "high" }, reason: /fixture refused thread\/settings\/update/u },
  { failure: "thread/name/set", options: { name: "requested name" }, reason: /fixture refused thread\/name\/set/u },
];

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") { return false; }
    throw error;
  }
}

// DSH's OAR 0.67.0 patch exposed these paths. Warm the same home first:
// cold-home coordination already cleans up a rejected initialize itself.
// oxlint-disable-next-line eslint/max-statements -- One real process, its explicit shutdown barrier and failure-safe cleanup.
test.each(failures)("$failure rejection waits for the app-server to exit", async ({ failure, options, reason }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-codex-startup-"));
  const pidFile = path.join(directory, "pid");
  const stopping = path.join(directory, "stopping");
  const release = path.join(directory, "release");
  const installation = { kind: "available", via: "executable", command: fakeAgentBinary(directory, [fixture]) } as const;
  let opening: Promise<unknown> | undefined = undefined;
  let settled = false;
  // POSIX uses a release file, not the escalation timer, to prove the wait.
  // Windows force-kills the process tree; it still checks exit at rejection.
  vi.stubEnv("OAR_KILL_GRACE_MS", "30000");
  try {
    const env = { CODEX_HOME: directory, OAR_FIXTURE_PID: pidFile };
    const warm = await codexSession(installation, { cwd: directory, env });
    await warm.dispose();
    opening = (async () => {
      try {
        const session = await codexSession(installation, {
          cwd: directory, ...options,
          env: { ...env, OAR_FIXTURE_FAILURE: failure, ...(process.platform === "win32" ? {} : { OAR_FIXTURE_RELEASE: release, OAR_FIXTURE_STOPPING: stopping }) },
        });
        await session.dispose();
        return null;
      } catch (error) { return error; }
      finally { settled = true; }
    })();
    if (process.platform !== "win32") {
      await expect.poll(() => existsSync(stopping) || settled, { timeout: 10_000 }).toBe(true);
      expect(settled, "open rejected before the app-server exited").toBe(false);
      expect(existsSync(stopping), "app-server was not asked to stop").toBe(true);
      const stoppingPid = Number(readFileSync(pidFile, "utf8"));
      expect(running(stoppingPid)).toBe(true);
      writeFileSync(release, "release");
    }
    const error = await opening;
    assert.ok(error instanceof Error, `open did not reject: ${String(error)}`);
    expect(error.message).toMatch(reason);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(running(pid), "open returned before its process exited").toBe(false);
  } finally {
    writeFileSync(release, "release");
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (running(pid)) { process.kill(pid, "SIGKILL"); }
      assert.ok(await gone(pid), `fixture process ${String(pid)} survived cleanup`);
    }
    await opening;
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
