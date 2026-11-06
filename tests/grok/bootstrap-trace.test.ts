import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { runExecutable } from "../../packages/oar/src/shared/executable/run.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

const observer = fileURLToPath(new URL("../../experiments/grok-startup/trace-bootstrap.ts", import.meta.url));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(async directory => rm(directory, { recursive: true, force: true }))); });

async function fixture(): Promise<{ directory: string; trace: string; script: string; env: NodeJS.ProcessEnv }> {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-grok-bootstrap-trace-"));
  directories.push(directory);
  const trace = path.join(directory, "trace.jsonl");
  return { directory, trace, script: path.join(directory, "bootstrap.cjs"), env: {
    ...process.env, GROK_HOME: directory, OAR_GROK_BOOTSTRAP_TRACE: trace,
  } };
}

async function entries(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, "utf8");
  return text.trim().split("\n").map(line => {
    const value = asRecord(parseJson(line));
    if (value === null) { throw new Error("invalid trace entry"); }
    return value;
  });
}

// Use require(), as the installed vendor launcher does. No vendor code is copied.
const operations = `
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const cp = require('node:child_process');
const bin = path.join(process.env.GROK_HOME, 'bin');
fs.mkdirSync(bin);
const br = path.join(process.env.GROK_HOME, 'grok.br');
fs.writeFileSync(br, zlib.brotliCompressSync(Buffer.from('fixture-private-content')));
const decoded = zlib.brotliDecompressSync(fs.readFileSync(br));
const temporary = path.join(bin, 'grok.tmp.123');
const versioned = path.join(bin, 'grok-1.0.70');
fs.writeFileSync(temporary, decoded);
fs.renameSync(temporary, versioned);
fs.copyFileSync(versioned, path.join(bin, 'grok'));
fs.renameSync(path.join(bin, 'grok'), path.join(bin, 'grok.old'));
fs.copyFileSync(versioned, path.join(bin, 'grok'));
try { fs.readFileSync(path.join(bin, 'grok-missing')); }
catch (error) { process.stdout.write(error.code + '\\n'); }
process.stdout.write(decoded.toString() + '\\n');
cp.spawn(process.execPath, ['-e', 'process.stdout.write("spawn-ok")'], { stdio: 'inherit' });
`;

// oxlint-disable-next-line max-statements -- Compare the same real process with and without observation, including the retained evidence.
test.each([false, true])("bootstrap observer preserves bytes, original failures and spawning when logging fails: %s", async (failLog) => {
  const control = await fixture();
  const observed = await fixture();
  await Promise.all([writeFile(control.script, operations), writeFile(observed.script, operations)]);
  if (failLog) { observed.env.OAR_GROK_BOOTSTRAP_TRACE = path.join(observed.directory, "missing", "trace"); }
  const original = await runExecutable(process.execPath, [control.script], { env: control.env, timeoutMs: 15_000 });
  const result = await runExecutable(process.execPath, ["--require", observer, observed.script], { env: observed.env, timeoutMs: 15_000 });
  expect(result.ok).toBe(true);
  expect(result.stdout).toBe(original.stdout);
  expect(result.stdout).toBe("ENOENT\nfixture-private-content\nspawn-ok");
  if (failLog) { expect(result.stderr).toBe("[grok startup probe] bootstrap trace write failed\n"); return; }
  const rows = await entries(observed.trace);
  expect(rows.map(row => row.phase)).toEqual([
    "hook_loaded", "write_started", "write_finished", "read_started", "read_finished",
    "decompress_started", "decompress_finished", "write_started", "write_finished",
    "rename_started", "rename_finished", "copy_started", "copy_finished",
    "rename_started", "rename_finished", "copy_started", "copy_finished", "read_started", "read_failed",
    "native_spawn_requested", "native_spawned",
  ]);
  expect(rows.find(row => row.phase === "read_failed")).toMatchObject({ code: "ENOENT", target: "versioned_binary" });
  expect(rows.find(row => row.phase === "rename_finished" && row.target === "backup_binary"))
    .toMatchObject({ source: "canonical_binary" });
  const text = await readFile(observed.trace, "utf8");
  expect(text).not.toContain(observed.directory);
  expect(text).not.toContain("fixture-private-content");
});

test("trace cap does not stop the original operations", async () => {
  const f = await fixture();
  await writeFile(f.script, `const fs = require('node:fs'); const path = require('node:path');
const p = path.join(process.env.GROK_HOME, 'grok.br'); fs.writeFileSync(p, 'x');
let total = 0; for (let i = 0; i < 3000; i++) { total += fs.readFileSync(p).length; }
process.stdout.write(String(total));`);
  const result = await runExecutable(process.execPath, ["--require", observer, f.script], { env: f.env, timeoutMs: 15_000 });
  expect(result).toMatchObject({ ok: true, stdout: "3000" });
  const text = await readFile(f.trace);
  expect(text.length).toBeLessThanOrEqual(64 * 1024);
  const rows = await entries(f.trace);
  expect(rows.at(-1)).toMatchObject({ phase: "trace_truncated" });
});

// oxlint-disable-next-line max-statements -- Keep the real-process kill and post-exit evidence in one test with guaranteed cleanup.
test("synchronous phase start survives termination before the operation returns", async () => {
  const f = await fixture();
  const setup = path.join(f.directory, "slow.cjs");
  await writeFile(setup, `require('node:zlib').brotliDecompressSync = () => {
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); return Buffer.alloc(0); };`);
  await writeFile(f.script, "require('node:zlib').brotliDecompressSync(Buffer.from('x'));");
  const child = spawn(process.execPath, ["--require", setup, "--require", observer, f.script], { env: f.env, stdio: "ignore" });
  const closed = once(child, "close");
  try {
    await vi.waitFor(async () => {
      const rows = await entries(f.trace);
      expect(rows.at(-1)).toMatchObject({ phase: "decompress_started", inputBytes: 1 });
    }, { timeout: 10_000 });
  } finally { child.kill("SIGKILL"); await closed; }
  const rows = await entries(f.trace);
  expect(rows.map(row => row.phase)).toEqual(["hook_loaded", "decompress_started"]);
});

test("observing spawn does not handle the launcher's otherwise unhandled error", async () => {
  const f = await fixture();
  await writeFile(f.script, "require('node:child_process').spawn(require('node:path').join(process.env.GROK_HOME, 'missing-command')); ");
  const result = await runExecutable(process.execPath, ["--require", observer, f.script], { env: f.env, timeoutMs: 15_000 });
  expect(result).toMatchObject({ ok: false, exitCode: 1 });
  expect(result.stderr).toContain("ENOENT");
  const rows = await entries(f.trace);
  expect(rows.map(row => row.phase)).toEqual(["hook_loaded", "native_spawn_requested"]);
});
