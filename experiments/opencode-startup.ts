/**
 * Compare cold and warm OpenCode v2 server startup on Linux/macOS.
 * node --import tsx experiments/opencode-startup.ts /absolute/path/to/opencode [output-dir]
 * Uses the same `serve --stdio --port 0` child as native ACP, without OAR,
 * credentials, sessions or model requests. Retains isolated state and stderr.
 * This is an observation: failed native starts remain in report.json.
 */
/* oxlint-disable eslint/no-await-in-loop -- Sequential starts are the control for concurrent starts. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const [binary, output = "oar-trial-run/opencode-startup"] = process.argv.slice(2);
assert.ok(binary !== undefined && path.isAbsolute(binary), "Provide an absolute executable path");
assert.notEqual(process.platform, "win32", "This probe owns POSIX process groups");
const directory = path.resolve(output);
await mkdir(directory, { recursive: true, mode: 0o700 });
const root = await mkdtemp(path.join(directory, "state-"));
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => [
  "PATH", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
].includes(key)));
const versionEnv = await environment("version");
const version = execFileSync(binary, ["--version"], {
  cwd: versionEnv.HOME, env: versionEnv, encoding: "utf8", timeout: 20_000,
}).trim();

async function environment(name: string): Promise<NodeJS.ProcessEnv> {
  const location = path.join(root, name);
  const directories = Object.fromEntries(["home", "config", "data", "cache", "state", "project"]
    .map((key) => [key, path.join(location, key)]));
  await Promise.all(Object.values(directories).map(async (dir) => { await mkdir(dir, { recursive: true, mode: 0o700 }); }));
  return {
    ...inherited, HOME: directories.home, OPENCODE_TEST_HOME: directories.home,
    XDG_CONFIG_HOME: directories.config, XDG_DATA_HOME: directories.data,
    XDG_CACHE_HOME: directories.cache, XDG_STATE_HOME: directories.state,
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_PRINT_LOGS: "1",
  };
}

interface Observation {
  readonly name: string;
  readonly ready: boolean;
  readonly elapsedMs: number;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly failure?: string;
}

function start(command: string, name: string, env: NodeJS.ProcessEnv): {
  observation: Promise<Observation>; close: () => Promise<void>;
} {
  const started = Date.now();
  const child = spawn(command, ["serve", "--stdio", "--port", "0"], {
    cwd: env.HOME, env, detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const result = Promise.withResolvers<Observation>();
  const closed = Promise.withResolvers<void>();
  let stderr = "";
  let exited = false;
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message: unknown = JSON.parse(line);
      if (typeof message === "object" && message !== null && "url" in message && typeof message.url === "string") {
        result.resolve({ name, ready: true, elapsedMs: Date.now() - started });
      }
    } catch { /* Readiness is JSON; non-JSON stdout does not prove readiness. */ }
  });
  child.on("error", (error) => {
    result.resolve({ name, ready: false, elapsedMs: Date.now() - started, failure: error.message });
  });
  child.on("close", (exitCode, signal) => {
    exited = true;
    result.resolve({ name, ready: false, elapsedMs: Date.now() - started, exitCode, signal });
    closed.resolve();
  });
  const deadline = setTimeout(() => {
    result.resolve({ name, ready: false, elapsedMs: Date.now() - started, failure: "startup deadline: 20 seconds" });
  }, 20_000);
  const observation = async (): Promise<Observation> => {
    try { return await result.promise; }
    finally { clearTimeout(deadline); }
  };
  const close = async (): Promise<void> => {
    child.stdin.end();
    await Promise.race([closed.promise, delay(1000)]);
    // Signal only this owned process group; also catch an orphaned child
    // whose parent exited before it could close the native ownership lease.
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* The group already exited. */ }
      await Promise.race([closed.promise, delay(1000)]);
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* The group already exited. */ }
    }
    if (!exited) { await closed.promise; }
    lines.close();
    await writeFile(path.join(directory, `${name}.stderr.log`), stderr, { mode: 0o600 });
  };
  return { observation: observation(), close };
}

const results: Observation[] = [];
const warm = await environment("sequential-then-warm");
for (let index = 0; index < 2; index += 1) {
  const run = start(binary, `sequential-${String(index)}`, warm);
  try { results.push(await run.observation); }
  finally { await run.close(); }
}
for (const [phase, env] of [["cold", await environment("cold-concurrent")], ["warm", warm]] as const) {
  const runs = Array.from({ length: 4 }, (_, index) => start(binary, `${phase}-${String(index)}`, env));
  const observations: Promise<Observation>[] = [];
  for (const run of runs) { observations.push(run.observation); }
  try { results.push(...await Promise.all(observations)); }
  finally { await Promise.all(runs.map(async (run) => { await run.close(); })); }
}
const report = { version, platform: process.platform, node: process.version, results };
await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
