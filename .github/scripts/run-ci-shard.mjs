// Runs one sharded platform-matrix job (setup runs once per shard, then each
// backend installs into an isolated env and runs behavior + vendor without
// early exit so one backend failure never hides another).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dailyShards } from "./ci-select.mjs";
import { formatError } from "./runtime-common.mjs";
import { installRuntime } from "./runtime-install.mjs";

const baselineFile = path.resolve(import.meta.dirname, "../runtime-versions.json");
const STEP_TIMEOUT_MS = 12 * 60 * 1000;

export function parseGithubEnv(content) {
  const env = {};
  const lines = content.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const heredoc = /^([^=]+)<<(.+)$/u.exec(line);
    if (heredoc) {
      const [, key, delim] = heredoc;
      const body = [];
      for (i += 1; i < lines.length && lines[i] !== delim; i += 1) { body.push(lines[i]); }
      env[key] = body.join("\n");
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) { env[line.slice(0, eq)] = line.slice(eq + 1); }
  }
  return env;
}

export function prependPath(env, extra, delimiter = path.delimiter) {
  const dirs = extra.filter(Boolean);
  if (dirs.length === 0) { return env; }
  const keys = Object.keys(env).filter(key => key.toLowerCase() === "path");
  const pathKey = keys[0] ?? "PATH";
  const existing = keys.map(key => env[key]).filter(Boolean);
  for (const key of keys) {
    if (key !== pathKey) { delete env[key]; }
  }
  env[pathKey] = [...dirs, ...existing].join(delimiter);
  return env;
}

function runCommand(command, args, env, timeoutMs = STEP_TIMEOUT_MS) {
  const isWin = process.platform === "win32";
  const result = spawnSync(command, args, {
    env,
    stdio: "inherit",
    timeout: timeoutMs,
    ...(isWin && (command === "pnpm" || command === "npm") ? { shell: true } : {}),
  });
  if (result.error) {
    process.stderr.write(`Command ${command} ${args.join(" ")} error: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

async function runEntry(entry, osName) {
  const started = Date.now();
  const suite = entry.suite ?? entry.backend;
  const trialDir = path.join(process.cwd(), "oar-trial-run", entry.backend);
  const envDir = mkdtempSync(path.join(tmpdir(), `oar-shard-${entry.backend}-`));
  const githubEnv = path.join(envDir, "github-env");
  const githubPath = path.join(envDir, "github-path");
  let failed = false;
  try {
    process.stdout.write(`\n::group::${entry.backend} (${entry.kind})\n`);
    const env = {
      ...process.env,
      OAR_TEST: suite,
      OAR_TRIAL_RUN_DIR: trialDir,
    };
    if (entry.kind === "acp") {
      env.OAR_TEST_REQUIRE_AVAILABLE = "1";
      env.OAR_TEST_CONCURRENCY = "2";
      env.OAR_TEST_MCP_PROGRESS = "1";
      if (osName === "windows-latest") { env.OAR_CHILD_STDERR = "inherit"; }
    } else if (entry.kind === "behavior") {
      if (entry.backend === "qoder-native" || entry.backend === "dsh-aimock") {
        env.OAR_TEST_CONCURRENCY = "2";
        env.OAR_CHILD_STDERR = "inherit";
      }
      if (entry.backend === "dsh-aimock" || entry.backend === "factory-aimock") {
        env.OAR_TEST_REQUIRE_AVAILABLE = "1";
      }
      if (osName === "windows-latest" && entry.backend === "codex-aimock") {
        env.OAR_CHILD_STDERR = "inherit";
      }
    }

    if (entry.install) {
      const pinKey = entry.pin ?? entry.backend;
      const report = await installRuntime(pinKey, baselineFile, { githubEnv, githubPath });
      process.stdout.write(`Verified ${pinKey} ${report.actualVersion}; manifest ${report.manifestSha256}\n`);
      if (existsSync(githubEnv)) {
        Object.assign(env, parseGithubEnv(readFileSync(githubEnv, "utf8")));
      }
      if (existsSync(githubPath)) {
        const extra = readFileSync(githubPath, "utf8").split(/\r?\n/u).filter(Boolean);
        prependPath(env, extra);
      }
    }

    if (entry.kind === "pi-rpc-windows-behavior") {
      const code = runCommand("pwsh", ["-NoProfile", "-NonInteractive", "-File", "./sea-trial/windows-resources.ps1", "-Stage", "behavior", "-Command", "pnpm run sea-trial"], env);
      if (code !== 0) { failed = true; }
    } else {
      const behaviorCode = runCommand("pnpm", ["run", "sea-trial"], env);
      if (behaviorCode !== 0) { failed = true; }
      const vendorArgs = entry.kind === "acp" ? ["vitest", "run", "sea-trial/vendor", "--maxWorkers", "2"] : ["vitest", "run", "sea-trial/vendor"];
      const vendorCode = runCommand("pnpm", vendorArgs, env);
      if (vendorCode !== 0) { failed = true; }
    }
  } catch (error) {
    process.stderr.write(`${entry.backend} failed: ${formatError(error)}\n`);
    failed = true;
  } finally {
    process.stdout.write("::endgroup::\n");
    rmSync(envDir, { recursive: true, force: true });
  }
  return { backend: entry.backend, ok: !failed, elapsedSec: ((Date.now() - started) / 1000).toFixed(1) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const shardId = process.argv[2];
  const shard = shardId ? dailyShards[shardId] : undefined;
  if (!shard) {
    process.stderr.write(`Unknown shard ${JSON.stringify(shardId)}; expected one of: ${Object.keys(dailyShards).join(", ")}\n`);
    process.exit(1);
  }
  const results = [];
  for (const entry of shard.entries) {
    results.push(await runEntry(entry, shard.os));
  }
  process.stdout.write(`\nShard ${shardId} summary:\n`);
  for (const r of results) {
    process.stdout.write(`  ${r.ok ? "PASS" : "FAIL"}  ${r.backend} (${r.elapsedSec}s)\n`);
  }
  if (results.some(r => !r.ok)) { process.exit(1); }
}
