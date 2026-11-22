import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createCursorRuntime, createPiRuntime, defaultRuntimes } from "../packages/oar/src/index.js";
import { withQueryDeadline } from "../packages/oar/src/shared/executable/query.js";
import { fakeAgentBinary, gone, reportedProcess, withTreeProbe } from "./fixtures/process-tree.js";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(new URL("fixtures/stalled-native-reader.mjs", import.meta.url));
// One representative per distinct transport and return shape (shared withQueryDeadline paths are not repeated per runtime).
const cases = [
  ["antigravity", "listModels"], ["codex", "listModels"], ["factory", "listModels"], ["qoder", "listModels"],
  ["claude", "skills"], ["dsh", "skills"], ["kimi", "skills"],
  ["pi", "listModels"], ["cursor", "listModels"], ["cursor", "authStatus"],
] as const;

function queryRuntime(runtime: string, command: string) {
  if (runtime === "pi") { return createPiRuntime({ execution: "subprocess", command }); }
  if (runtime === "cursor") { return createCursorRuntime({ execution: "subprocess", sdkModule: pathToFileURL(script).href }); }
  return defaultRuntimes.require(runtime);
}

const versions: Readonly<Record<string, string>> = { pi: "1.5.2", qoder: "1.1.91" };

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

// A real native process with an independently launched tool. Advance only the
// answer deadline after startup, then let actual process shutdown run normally.
test.each(cases)("%s %s bounds the read and reclaims its process tree", async (runtime, operation) => {
  vi.stubEnv("OAR_KILL_GRACE_MS", "500");
  // oxlint-disable-next-line max-statements -- Keep the native startup, answer deadline and both PID observations in the same probe.
  await withTreeProbe({ ignoreSigterm: true, detachTool: true }, async probe => {
    const command = fakeAgentBinary(probe.dir, [script]);
    const launcherReport = runtime === "claude" && process.platform === "win32" ? join(probe.dir, "launcher.json") : undefined;
    const adapter = queryRuntime(runtime, command);
    const read = adapter[operation];
    if (read === undefined) { throw new Error(`Missing expected ${runtime} reader`); }
    const installation = runtime === "pi" || runtime === "cursor" ? { kind: "available", via: "bundled" } as const
      : { kind: "available", via: "executable", command, ...(runtime === "dsh" ? { version: "0.2.2-rc.3" } : {}) } as const;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = read(installation, { timeoutMs: 5000, cwd: probe.dir, env: { ...probe.env, HOME: probe.dir, USERPROFILE: probe.dir, GEMINI_HOME: null, CURSOR_API_KEY: null, KIMI_CODE_HOME: probe.dir,
      OAR_FIXTURE_LAUNCHER_REPORT: launcherReport ?? null, OAR_FIXTURE_VERSION: versions[runtime] ?? null, OAR_FIXTURE_QODER: runtime === "qoder" ? "1" : null } })
      .catch((error: unknown) => error);
    const tree = await probe.tree().finally(() => { vi.advanceTimersByTime(5000); vi.useRealTimers(); });
    const answer = await result;
    if (operation === "skills") { expect(answer).toMatchObject({ kind: "unavailable", code: "timeout" }); }
    else if (operation === "authStatus") { expect(answer).toMatchObject({ kind: "unknown" }); }
    else { expect(answer).toBeInstanceOf(Error); }
    if (process.platform !== "win32") { expect(await gone(tree.agent, 0)).toBe(false); }
    expect(await gone(tree.agent), "fixture agent still running").toBe(true);
    expect(await gone(tree.grandchild), "fixture tool still running").toBe(true);
    if (launcherReport !== undefined) {
      const launcher = reportedProcess(JSON.parse(readFileSync(launcherReport, "utf8")));
      expect(await gone(launcher), "Claude fixture cmd.exe launcher still running").toBe(true);
    }
  });
}, 20_000);

test("a native answer survives when only its process cleanup exceeds the caller's deadline", async () => {
  vi.useFakeTimers();
  const stopping = Promise.withResolvers<void>();
  const exit = Promise.withResolvers<void>();
  const read = withQueryDeadline("catalog", 500, async (_signal, own) => {
    own({ kill: stopping.resolve, exited: exit.promise });
    await Promise.resolve();
    return "catalog received";
  });
  try {
    await stopping.promise;
    vi.advanceTimersByTime(500);
    await expect(read).resolves.toBe("catalog received");
  } finally { exit.resolve(); }
});
