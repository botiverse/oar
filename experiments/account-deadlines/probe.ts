import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { codexRuntime } from "../../packages/oar/src/runtimes/codex/index.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

interface Observation { readonly event: string; readonly at: number; readonly pids: number[] }
const timeoutMs = 800;
const wrapper = fileURLToPath(new URL("wrapper.mjs", import.meta.url));

function observations(file: string): Observation[] {
  try {
    return readFileSync(file, "utf8").trim().split("\n").map((line) => {
      const row = asRecord(parseJson(line));
      assert.ok(row !== null && typeof row.event === "string" && typeof row.at === "number" && Array.isArray(row.pids));
      return { event: row.event, at: row.at, pids: row.pids.filter((pid): pid is number => typeof pid === "number") };
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") { return []; }
    throw error;
  }
}

function alive(pid: number): boolean {
  try {
    // A reparented zombie has exited but can still answer kill(pid, 0).
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z") === false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") { return false; }
    throw error;
  }
}

function environment(home: string, native: string, operation: string): Record<string, string | null> {
  const cleared = Object.fromEntries(Object.keys(process.env)
    .filter((name) => /TOKEN|AUTH|API_KEY|SECRET|^CODEX_|^OPENAI_|^NODE_OPTIONS$/iu.test(name))
    .map((name) => [name, null]));
  return { ...cleared, HOME: home, CODEX_HOME: path.join(home, "codex"),
    HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9",
    OPENAI_BASE_URL: "http://127.0.0.1:9/v1", OAR_DEADLINE_NATIVE: native,
    OAR_DEADLINE_EVENTS: path.join(home, "events.jsonl"), OAR_DEADLINE_METHOD: operation === "read"
      ? "account/rateLimits/read" : "account/rateLimitResetCredit/consume" };
}

async function waitForCleanup(file: string, started: number): Promise<Observation[]> {
  let events: Observation[] = [];
  do {
    events = observations(file);
    const pids = events.flatMap((event) => event.pids);
    if (pids.length > 0 && pids.every((pid) => !alive(pid))) { return events; }
    // oxlint-disable-next-line no-await-in-loop -- Poll only the owned probe processes until cleanup or the diagnostic cap.
    await delay(20);
  } while (performance.now() - started < timeoutMs + 15_000);
  throw new Error("Owned probe processes survived the cleanup observation window");
}

/** Emergency cleanup is only for a failed probe; a passing run must need none. */
function rescue(file: string): void {
  for (const pid of new Set(observations(file).flatMap((event) => event.pids))) {
    if (alive(pid)) {
      try { process.kill(pid, "SIGKILL"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) { throw error; } }
    }
  }
}

async function measure(native: string, operation: "read" | "redeem"): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "oar-account-deadline-"));
  const file = path.join(home, "events.jsonl");
  try {
    await mkdir(path.join(home, "codex"));
    await writeFile(path.join(home, "codex", "config.toml"), 'cli_auth_credentials_store = "file"\nchatgpt_base_url = "http://127.0.0.1:9"\n');
    const env = environment(home, native, operation);
    const installation = { kind: "available", via: "executable", command: wrapper } as const;
    const epoch = Date.now();
    const started = performance.now();
    const call = operation === "read"
      ? codexRuntime.accountUsage(installation, { env, timeoutMs })
      : codexRuntime.redeemLimitReset(installation, { env, timeoutMs, idempotencyKey: "isolated-repro-only" });
    const failure = await call.then(() => null, (error: unknown) => error);
    const rejectedMs = Math.round(performance.now() - started);
    assert.ok(failure instanceof Error, "the withheld account request must reject");
    const events = await waitForCleanup(file, started);
    assert.ok(events.some((event) => event.event === "withheld"), "native startup must reach the requested account method");
    const goneMs = Math.round(performance.now() - started);
    console.log(JSON.stringify({ operation, timeoutMs, rejectedMs, goneMs,
      error: failure.message, remaining: [], events: events.map(({ event, at }) => ({ event, elapsedMs: at - epoch })) }));
  } finally {
    rescue(file);
    await rm(home, { recursive: true, force: true });
  }
}

assert.equal(process.platform, "linux", "This native probe uses Linux /proc and SIGSTOP");
const native = process.argv.at(2);
assert.ok(native !== undefined && path.isAbsolute(native), "Pass the absolute path of an isolated Codex installation");
await measure(native, "read");
await measure(native, "redeem");
