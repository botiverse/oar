/**
 * Native initialization only: no login, model turn, OAR adapter or npm wrapper.
 * pnpm tsx experiments/codex-concurrent-startup.ts /path/to/native/codex [width=8] [rounds=3] [startup|models]
 * Uses disposable homes; reports observations rather than asserting a vendor guarantee.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const [command, widthArg, roundsArg, group = "startup"] = process.argv.slice(2);
assert.ok(command !== undefined, "pass the native codex binary, not an npm .cmd or JS wrapper");
const binary = path.resolve(command);
const width = Number(widthArg ?? 8);
const rounds = Number(roundsArg ?? 3);
assert.ok(Number.isInteger(width) && width > 0 && Number.isInteger(rounds) && rounds > 0);
assert.ok(group === "startup" || group === "models", "choose startup or models");
assert.ok(group !== "models" || width >= 2, "models overlap requires width >= 2");
const version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
const root = await mkdtemp(path.join(tmpdir(), "oar-codex-startup-"));
const out = path.resolve("oar-trial-run", `codex-startup-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(out, { recursive: true });

interface Observation {
  command: "app-server" | "debug models";
  modelCount: number | null;
  home: string;
  pid: number | null;
  startedAt: string;
  settledAt: string | null;
  exitedAt: string | null;
  kind: "starting" | "ready" | "rpc_error" | "spawn_error" | "stdin_error" | "exited" | "timeout";
  error: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

async function home(name: string): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "config.toml"), [
    'model = "gpt-5.1"', 'model_provider = "startup-probe"',
    "[model_providers.startup-probe]", 'name = "startup-probe"',
    'base_url = "http://127.0.0.1:1/v1"', 'env_key = "OAR_STARTUP_PROBE_KEY"', 'wire_api = "responses"', "",
  ].join("\n"));
  return directory;
}

interface ProbeChild {
  observation: Observation;
  initialized: Promise<void>;
  stop(): Promise<Observation>;
}

function jsonLine(line: string): unknown {
  try { return JSON.parse(line); } catch { return null; }
}

function start(directory: string, models = false): ProbeChild {
  let stderr = Buffer.alloc(0);
  const child = spawn(binary, models ? ["debug", "models"] : ["app-server", "--listen", "stdio://"], {
    env: { ...process.env, CODEX_HOME: directory, OAR_STARTUP_PROBE_KEY: "local-probe" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const observation: Observation = {
    command: models ? "debug models" : "app-server", modelCount: null,
    home: directory, pid: child.pid ?? null, startedAt: new Date().toISOString(),
    settledAt: null, exitedAt: null, kind: "starting", error: null,
    exitCode: null, signal: null, stderr: "",
  };
  const initialized = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const timer = setTimeout(() => { settle("timeout", "command exceeded the probe's 15 s observation window"); }, 15_000);
  function settle(kind: Observation["kind"], error: string | null = null): void {
    if (observation.kind !== "starting") { return; }
    clearTimeout(timer);
    observation.kind = kind;
    observation.error = error;
    observation.settledAt = new Date().toISOString();
    initialized.resolve();
  }
  child.stderr.on("data", (chunk: Buffer) => { stderr = Buffer.from(Buffer.concat([stderr, chunk]).subarray(-8192)); });
  child.on("error", (error) => { settle("spawn_error", error.message); });
  child.stdin.on("error", (error) => { settle("stdin_error", error.message); });
  child.on("exit", (code, signal) => {
    observation.exitCode = code;
    observation.signal = signal;
    observation.exitedAt = new Date().toISOString();
    if (!models) { settle("exited"); }
  });
  // close follows exit and drains the last stderr bytes before recording them.
  let modelJson = "";
  child.on("close", () => {
    if (models && observation.exitCode === 0) {
      const payload = jsonLine(modelJson);
      const catalog = typeof payload === "object" && payload !== null && "models" in payload ? payload.models : null;
      observation.modelCount = Array.isArray(catalog) ? catalog.length : null;
      settle(observation.modelCount === null ? "rpc_error" : "ready", observation.modelCount === null ? "invalid models JSON" : null);
    } else { settle("exited"); }
    exited.resolve();
  });
  let buffer = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    if (models) { modelJson += chunk; return; }
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const message = jsonLine(line);
      if (typeof message === "object" && message !== null && "id" in message && message.id === 1) {
        const error = "error" in message ? message.error : undefined;
        if (error === undefined) {
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        }
        settle(error === undefined ? "ready" : "rpc_error", error === undefined ? null : JSON.stringify(error));
      }
    }
  });
  if (!models) {
    child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: {
      clientInfo: { name: "oar-startup-probe", version: "0.0.0" }, capabilities: { experimentalApi: true },
    } })}\n`);
  }
  return {
    observation,
    initialized: initialized.promise,
    async stop(): Promise<Observation> {
      child.stdin.end();
      child.kill("SIGTERM");
      const force = setTimeout(() => { child.kill("SIGKILL"); }, 2000);
      await exited.promise;
      clearTimeout(force);
      observation.stderr = stderr.toString("utf8");
      return observation;
    },
  };
}

type Mode = "shared-fresh" | "isolated-fresh" | "shared-warm" | "shared-serial-start" | "models-only" | "models-with-server";
interface ProbeResult {
  mode: Mode;
  round: number;
  warmup: Observation | null;
  observations: Observation[];
  files?: string[];
}
async function probe(mode: Mode, round: number): Promise<ProbeResult> {
  const prefix = `${mode}-${String(round)}`;
  const directories = mode === "isolated-fresh"
    ? await Promise.all(Array.from({ length: width }, async (_, i) => { const directory = await home(`${prefix}-${String(i)}`); return directory; }))
    : Array.from({ length: width }, () => path.join(root, prefix));
  if (mode !== "isolated-fresh") { await home(prefix); }
  let warmup: Observation | null = null;
  if (mode === "shared-warm") {
    const [directory] = directories;
    assert.ok(directory !== undefined);
    const child = start(directory);
    await child.initialized;
    warmup = await child.stop();
  }
  const children: ProbeChild[] = [];
  for (const directory of directories) {
    const child = start(directory, mode === "models-only" || (mode === "models-with-server" && children.length > 0));
    children.push(child);
    // Each successful initialization precedes the next start in this control.
    // oxlint-disable-next-line no-await-in-loop
    if (mode === "shared-serial-start") { await child.initialized; }
  }
  await Promise.all(children.map(async (child) => { await child.initialized; }));
  const observations = await Promise.all(children.map(async (child) => { const observation = await child.stop(); return observation; }));
  const result: ProbeResult = { mode, round, warmup, observations };
  const [directory] = directories;
  if (group === "models" && directory !== undefined) {
    const files = await readdir(directory, { recursive: true });
    result.files = files.toSorted();
  }
  await writeFile(path.join(out, `${prefix}.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${prefix}: ${String(observations.filter((entry) => entry.kind === "ready").length)}/${String(width)} ready\n`);
  return result;
}

const results = [];
const modes: Mode[] = group === "models" ? ["models-only", "models-with-server"] : ["shared-fresh", "isolated-fresh", "shared-warm", "shared-serial-start"];
for (const mode of modes) {
  for (let round = 0; round < rounds; round += 1) {
    // Run controls separately so resource load from one does not confound another.
    // oxlint-disable-next-line no-await-in-loop
    results.push(await probe(mode, round));
  }
}
await writeFile(path.join(out, "report.json"), `${JSON.stringify({ binary, version, platform: process.platform, arch: process.arch, width, rounds, group, results }, null, 2)}\n`);
await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
process.stdout.write(`observations: ${out}\n`);
