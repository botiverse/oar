import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  requiresShell,
  spawnLineProcess,
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

test("a missing executable rejects spawned and exits exactly once", async () => {
  const child = spawnLineProcess("/nonexistent/oar-fixture-binary", []);
  const codes: (number | null)[] = [];
  child.onExit((code) => {
    codes.push(code);
  });
  await assert.rejects(child.spawned);
  await delay(100);
  assert.deepEqual(codes, [null]);
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
