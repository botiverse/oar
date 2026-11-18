import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { runExecutable } from "../packages/oar/src/shared/executable/run.js";
import { PIPE_CLOSE_MS } from "../packages/oar/src/shared/executable/pipe-close.js";

// A stopped command's result comes with `close` (every pipe at EOF) whenever
// that comes: the bounded wait for pipes held past the stop's SIGKILL
// (process-held-pipes.test.ts) only bounds it, and the result never waits on
// the kill grace's unref'd timer when nothing else holds the event loop.
const posix = process.platform !== "win32";
const HUNG = "hung";
const within = async <T>(work: Promise<T>, ms: number): Promise<Awaited<T> | typeof HUNG> => {
  const result = await Promise.race([work, delay<typeof HUNG>(ms, HUNG, { ref: false })]);
  return result;
};

afterEach(() => { vi.unstubAllEnvs(); });

// Review round 2 (blocking): `close` completes a stopped command whenever it comes; the wait for held pipes only bounds it.
test.skipIf(!posix)("a command that exits on SIGTERM returns at once when its timeout stops it, not after the kill grace", async () => {
  vi.stubEnv("OAR_KILL_GRACE_MS", "10000");
  const begun = performance.now();
  const result = await within(runExecutable("sleep", ["30"], { timeoutMs: 300 }), 5000);
  const elapsedMs = performance.now() - begun;
  expect(result === HUNG ? result : { ok: result.ok, timeoutMs: result.diagnostics?.timeoutMs, cleanup: result.diagnostics?.cleanup, prompt: elapsedMs < 300 + PIPE_CLOSE_MS })
    .toEqual({ ok: false, timeoutMs: 300, cleanup: undefined, prompt: true });
});

test.skipIf(!posix)("a command that exits on SIGTERM returns at once when its caller aborts it, not after the kill grace", async () => {
  vi.stubEnv("OAR_KILL_GRACE_MS", "10000");
  const begun = performance.now();
  const result = await within(runExecutable("sleep", ["30"], { signal: AbortSignal.timeout(300) }), 5000);
  const elapsedMs = performance.now() - begun;
  expect(result === HUNG ? result : { ok: result.ok, error: result.diagnostics?.error?.code, cleanup: result.diagnostics?.cleanup, prompt: elapsedMs < 300 + PIPE_CLOSE_MS })
    .toEqual({ ok: false, error: "ABORT_ERR", cleanup: undefined, prompt: true });
});

const runModule = new URL("../packages/oar/src/shared/executable/run.ts", import.meta.url).href;

// The maintainer's repro: a CLI awaiting one probe has nothing else on its event loop; an unref'd timer must not hold its result (exit 13).
test.skipIf(!posix)("a lone stopped probe settles with nothing else on the event loop: timed out, aborted, and one that only the SIGKILL ends", () => {
  const source = `
    import { runExecutable } from ${JSON.stringify(runModule)};
    const summary = (result) => [result.ok, result.diagnostics?.timeoutMs ?? result.diagnostics?.error?.code].join(" ");
    const timedOut = await runExecutable("sleep", ["30"], { timeoutMs: 300 });
    const aborted = await runExecutable("sleep", ["30"], { signal: AbortSignal.timeout(300) });
    process.env.OAR_KILL_GRACE_MS = "300";
    const killed = await runExecutable("sh", ["-c", 'trap "" TERM; exec sleep 30'], { timeoutMs: 300 });
    process.stdout.write([timedOut, aborted, killed].map(summary).join(", "));
  `;
  const host = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { encoding: "utf8", timeout: 20_000 });
  expect({ status: host.status, stdout: host.stdout, stderr: host.stderr }).toEqual({ status: 0, stdout: "false 300, false ABORT_ERR, false 300", stderr: "" });
});
