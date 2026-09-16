import assert from "node:assert/strict";
import { test } from "vitest";
import { requiresShell, spawnLineProcess } from "../packages/oar/src/shared/executable/index.js";

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
  await child.exited;
  assert.deepEqual(lines, ["a", "bc", "d"]);
  assert.deepEqual(codes, [0]);
});

test("line buffering preserves UTF-8 split across byte chunks", async () => {
  // Regression transferred from Raft's runtimeSession test. A real child
  // waits for acknowledgment of each byte, so the OS cannot merge the
  // multibyte characters into one chunk and accidentally hide the defect.
  const expected = JSON.stringify({ text: "hello 你好🌊" });
  const child = spawnLineProcess(process.execPath, [
    "-e",
    String.raw`
      const bytes = Buffer.from(JSON.stringify({ text: "hello 你好🌊" }) + "\n");
      let offset = 0;
      function sendNextByte() {
        if (offset === bytes.length) {
          process.stdin.destroy();
          return;
        }
        process.stdout.write(bytes.subarray(offset, ++offset));
      }
      process.stdin.on("data", sendNextByte);
      sendNextByte();
    `,
  ]);
  const { promise: line, resolve } = Promise.withResolvers<string>();
  child.onLine(resolve);
  child.stdout.on("data", () => {
    child.write("next\n");
  });
  try {
    await child.spawned;
    assert.equal(await line, expected);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("exit fires exactly once with the exit code", async () => {
  const child = spawnLineProcess(process.execPath, ["-e", "process.exit(3);"]);
  const codes: (number | null)[] = [];
  child.onExit((code) => {
    codes.push(code);
  });
  await child.exited;
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
  await child.exited;
  assert.equal(codes.length, 1, "exit fires exactly once");
  assert.ok(spawnFailed || codes[0] !== 0, "a missing executable must not look successful");
});

async function writeThenKill(
  child: ReturnType<typeof spawnLineProcess>,
  received: Promise<void>,
): Promise<void> {
  const timeout = setTimeout(() => { child.kill(); }, 3000);
  try {
    child.write("hello\n");
    await Promise.race([received, child.exited]);
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
  }
}

async function echoRoundTrip(): Promise<{ lines: string[]; exits: number }> {
  const child = spawnLineProcess(process.execPath, [
    "-e",
    'process.stdin.on("data", (d) => process.stdout.write(d));',
  ]);
  await child.spawned;
  const lines: string[] = [];
  const received = Promise.withResolvers<void>();
  let exits = 0;
  child.onLine((line) => {
    lines.push(line);
    received.resolve();
  });
  child.onExit(() => {
    exits += 1;
  });
  await writeThenKill(child, received.promise);
  return { lines, exits };
}

test("write reaches stdin and kill tears the process down", async () => {
  const { lines, exits } = await echoRoundTrip();
  assert.deepEqual(lines, ["hello"]);
  assert.equal(exits, 1);
});
