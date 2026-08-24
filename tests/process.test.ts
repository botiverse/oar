import assert from "node:assert/strict";
import { test } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import {
  requiresShell,
  resolveExecutable,
  spawnLineProcess,
  type ExecFileSyncLike,
} from "../packages/oar/src/shared/executable/index.js";

test("requiresShell matches windows cmd and bat shims only", () => {
  assert.equal(requiresShell("claude.cmd", "win32"), true);
  assert.equal(requiresShell("CLAUDE.CMD", "win32"), true);
  assert.equal(requiresShell("tool.bat", "win32"), true);
  assert.equal(requiresShell("claude.exe", "win32"), false);
  assert.equal(requiresShell("claude", "win32"), false);
  assert.equal(requiresShell("claude.cmd", "linux"), false);
  assert.equal(requiresShell("claude.cmd", "darwin"), false);
});

test("line buffering joins partial chunks and splits complete lines", async () => {
  const child = spawnLineProcess(process.execPath, [
    "-e",
    String.raw`process.stdout.write("a\nb"); setTimeout(() => { process.stdout.write("c\nd\n"); }, 30);`,
  ]);
  const lines: string[] = [];
  child.onLine((line) => {
    lines.push(line);
  });
  const codes: (number | null)[] = [];
  child.onExit((code) => {
    codes.push(code);
  });
  await delay(300);
  assert.deepEqual(lines, ["a", "bc", "d"]);
  assert.deepEqual(codes, [0]);
});

test("exit fires exactly once with the exit code", async () => {
  const child = spawnLineProcess(process.execPath, ["-e", "process.exit(3);"]);
  const codes: (number | null)[] = [];
  child.onExit((code) => {
    codes.push(code);
  });
  await delay(300);
  assert.deepEqual(codes, [3]);
});

test("a missing executable fails loudly and exits exactly once", async () => {
  const child = spawnLineProcess("/nonexistent/oar-fixture-binary", []);
  const codes: (number | null)[] = [];
  child.onExit((code) => {
    codes.push(code);
  });
  // Platform-honest: POSIX rejects `spawned` (ENOENT before a process
  // exists); Windows under cross-spawn may start its shim wrapper first and
  // surface the failure as a non-zero exit instead. Either way it must fail
  // loudly, never look like a healthy process, and exit exactly once.
  const spawnFailed = await child.spawned.then(() => false, () => true);
  await delay(200);
  assert.equal(codes.length, 1, "exit fires exactly once");
  assert.ok(spawnFailed || codes[0] !== 0, "a missing executable must not look successful");
});

async function writeThenKill(child: ReturnType<typeof spawnLineProcess>): Promise<void> {
  child.write("hello\n");
  await delay(200);
  child.kill();
  await delay(200);
}

async function echoRoundTrip(): Promise<{ lines: string[]; exits: number }> {
  const child = spawnLineProcess(process.execPath, [
    "-e",
    'process.stdin.on("data", (d) => process.stdout.write(d));',
  ]);
  await child.spawned;
  const lines: string[] = [];
  let exits = 0;
  child.onLine((line) => {
    lines.push(line);
  });
  child.onExit(() => {
    exits += 1;
  });
  await writeThenKill(child);
  return { lines, exits };
}

test("write reaches stdin and kill tears the process down", async () => {
  const { lines, exits } = await echoRoundTrip();
  assert.deepEqual(lines, ["hello"]);
  assert.equal(exits, 1);
});

test("windows resolution hands the target name to powershell via env, not argv", () => {
  // Regression: powershell -Command appends trailing argv to the command
  // string instead of binding $args, so the name must travel in the env.
  const calls: { args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const execFileSyncFn: ExecFileSyncLike = (_command, args, options) => {
    calls.push({ args, env: options.env });
    return `${String.raw`C:\shims\codex.cmd`}\r\n`;
  };
  const resolved = resolveExecutable("codex", { platform: "win32", execFileSyncFn });
  assert.equal(resolved, String.raw`C:\shims\codex.cmd`);
  const [call] = calls;
  assert.ok(call !== undefined && calls.length === 1);
  assert.equal(call.env?.OAR_RESOLVE_TARGET, "codex");
  assert.ok(!call.args.includes("codex"), "target must not ride argv after -Command");
});
