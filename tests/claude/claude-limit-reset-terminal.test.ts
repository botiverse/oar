/* oxlint-disable unicorn/prefer-event-target -- The fake child stands in for Node's ChildProcess and its streams, which are EventEmitters. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";

import { openScriptTerminal, scriptInvocation, type ClaudeLimitResetTerminal, type ScriptTerminalHost, type TerminalProcess } from "../../packages/oar/src/shared/executable/script-terminal.js";

const INPUT = { command: "/opt/claude code/it's/claude", cwd: "/work", env: { PATH: "/usr/bin", SHELL: "/usr/bin/fish", HOME: "/home/person" }, cols: 120, rows: 45, platform: "linux" as const };

/** A host with a process table and no real processes: `script` (100) runs the program (101), which has children. */
function fakeHost(options: { ignoresTerm?: number[]; noScript?: boolean } = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 100,
    stdin: Object.assign(new EventEmitter(), { writable: true, written: new Array<string>(), write(data: string) { this.written.push(data); return true; } }),
    stdout: new EventEmitter(),
  });
  let table: TerminalProcess[] = [
    { pid: 1, parentPid: 0, startedAt: "1" },
    { pid: 50, parentPid: 1, startedAt: "5" },
    { pid: 100, parentPid: 50, startedAt: "10" },
    { pid: 101, parentPid: 100, startedAt: "11" },
    { pid: 102, parentPid: 101, startedAt: "12" },
    { pid: 103, parentPid: 102, startedAt: "13" },
    { pid: 200, parentPid: 50, startedAt: "20" },
  ];
  const signals: [number, string][] = [];
  const spawned: { file: string; args: readonly string[]; options: { cwd?: string; detached?: boolean; env?: NodeJS.ProcessEnv } }[] = [];
  const end = (pid: number) => {
    table = table.filter((each) => each.pid !== pid);
    if (pid === 101) { setTimeout(() => { end(100); }, 10); }
    if (pid === 100) { child.emit("exit", 0, null); }
  };
  const host: ScriptTerminalHost = {
    findScript: () => (options.noScript === true ? null : "/usr/bin/script"),
    // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- A fake child with only what the terminal touches.
    spawn: ((file: string, args: readonly string[], spawnOptions: object) => {
      spawned.push({ file, args, options: spawnOptions });
      return child;
    }) as unknown as ScriptTerminalHost["spawn"],
    listProcesses: () => table,
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      if (pid < 0) { return; }
      if (signal === "SIGKILL" || options.ignoresTerm?.includes(pid) !== true) { setTimeout(() => { end(pid); }, 20); }
    },
    hostPid: 4242,
  };
  return { host, child, signals, spawned, table: () => table, add: (entry: TerminalProcess) => { table = [...table, entry]; } };
}

function opened(terminal: ClaudeLimitResetTerminal | null): ClaudeLimitResetTerminal {
  assert.ok(terminal, "a terminal was opened");
  return terminal;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// oxlint-disable-next-line eslint/max-statements -- One shell line, each of its parts checked in order.
test("util-linux script runs one shell line under /bin/sh: size, the host watchdog, then the quoted program", () => {
  const { file, args, env } = scriptInvocation(INPUT, "/usr/bin/script", 4242);
  assert.equal(file, "/usr/bin/script");
  assert.equal(args.length, 3);
  assert.equal(args[0], "-qfc");
  assert.equal(args[2], "/dev/null");
  const line = args[1] ?? "";
  assert.ok(line.startsWith("stty rows 45 cols 120 2>/dev/null; ( trap '' TERM; while kill -0 4242 2>/dev/null && kill -0 $$ 2>/dev/null; do sleep 1; done; "));
  // The whole session (the program's children too), not only the program; the program alone without pkill.
  assert.ok(line.includes("kill -0 4242 2>/dev/null || { pkill -TERM -s $$ || kill -TERM $$; sleep 2; pkill -KILL -s $$ || kill -KILL $$; } ) </dev/null >/dev/null 2>&1 &"));
  assert.ok(line.includes(` '/opt/claude code/it'\\''s/claude'; if command -v pgrep`), "a path with a space and a quote stays one word; then the session is ended");
  assert.ok(line.endsWith(`for p in $(pgrep -s $$); do [ "$p" = "$$" ] || kill -KILL "$p" 2>/dev/null; done; else kill -KILL 0; fi`));
  assert.deepEqual(
    { SHELL: env.SHELL, TERM: env.TERM, COLUMNS: env.COLUMNS, LINES: env.LINES, HOME: env.HOME, PATH: env.PATH },
    { SHELL: "/bin/sh", TERM: "xterm-256color", COLUMNS: "120", LINES: "45", HOME: "/home/person", PATH: "/usr/bin" },
  );
});

test("BSD script takes the same line as arguments to /bin/sh", () => {
  const { args } = scriptInvocation({ ...INPUT, platform: "darwin" }, "/usr/bin/script", 4242);
  assert.deepEqual(args.slice(0, 4), ["-q", "/dev/null", "/bin/sh", "-c"]);
  assert.equal(args[4], scriptInvocation(INPUT, "/usr/bin/script", 4242).args[1]);
});

test("watchdog verifies host start identity on Linux and Darwin when provided", () => {
  const linuxLine = scriptInvocation(INPUT, "/usr/bin/script", 4242, "987654").args[1] ?? "";
  assert.ok(linuxLine.includes("IFS= read -r _s < /proc/4242/stat"));
  assert.ok(linuxLine.includes(`[ "\${20}" = '987654' ]`));
  const darwinLine = scriptInvocation({ ...INPUT, platform: "darwin" }, "/usr/bin/script", 4242, "Wed Nov  2 09:05:00 2026").args[4] ?? "";
  assert.ok(darwinLine.includes("ps -p 4242 -o stat=,lstart="));
  assert.ok(darwinLine.includes("[ \"$_s\" = 'Wed Nov  2 09:05:00 2026' ]"));
});

test("openScriptTerminal reads hostPid start time from host process list", () => {
  const { host, spawned } = fakeHost();
  const prevList = host.listProcesses.bind(host);
  host.listProcesses = () => [...prevList(), { pid: 4242, parentPid: 1, startedAt: "445566" }];
  const terminal = opened(openScriptTerminal(INPUT, host));
  assert.ok((spawned[0]?.args[1] ?? "").includes("'445566'"));
  void terminal.kill();
});

test("openScriptTerminal passes host.hostPid to hostStartedAt when provided", () => {
  const { host, spawned } = fakeHost();
  const seenPids: number[] = [];
  const terminal = opened(openScriptTerminal(INPUT, {
    ...host,
    hostPid: 9876,
    hostStartedAt: (pid) => {
      seenPids.push(pid);
      return "778899";
    },
  }));
  assert.deepEqual(seenPids, [9876]);
  assert.ok((spawned[0]?.args[1] ?? "").includes("'778899'"));
  void terminal.kill();
});

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) { return; }
  try { process.kill(-pid, "SIGKILL"); } catch {}
}

async function runDarwinWatchdogCase(spec: { dir: string; prog: string; pid: number; startedAt: string; timeoutMs: number }): Promise<boolean> {
  const env = { PATH: `${spec.dir}:/usr/bin:/bin` };
  const child = spawn("/bin/sh", ["-c", scriptInvocation({ ...INPUT, platform: "darwin", command: spec.prog, env }, "/usr/bin/script", spec.pid, spec.startedAt).args[4] ?? ""], { env, detached: true, stdio: "ignore" });
  const exited = Promise.withResolvers<boolean>();
  child.once("exit", () => { exited.resolve(true); });
  const timer = setTimeout(() => { exited.resolve(false); }, spec.timeoutMs);
  const done = await exited.promise;
  clearTimeout(timer);
  if (!done) { killProcessGroup(child.pid); }
  return done;
}

async function createDarwinWatchdogFixture(): Promise<{ dir: string; prog: string; pid: number; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oar-darwin-watchdog-"));
  const replacement = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
  const pid = replacement.pid ?? 0;
  assert.ok(pid > 0);
  const prog = path.join(dir, "prog.sh");
  await writeFile(path.join(dir, "ps"), "#!/bin/sh\necho \"S+   Wed Nov  2 09:05:00 2026\"\n", { mode: 0o700 });
  await writeFile(prog, "#!/bin/sh\nexec sleep 30\n", { mode: 0o700 });
  return {
    dir,
    prog,
    pid,
    cleanup: async () => {
      try { process.kill(pid, "SIGKILL"); } catch {}
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test.skipIf(process.platform === "win32")("Darwin watchdog stops on reused PID start mismatch and stays alive when start matches", async () => {
  vi.useRealTimers();
  const fixture = await createDarwinWatchdogFixture();
  try {
    assert.equal(await runDarwinWatchdogCase({ dir: fixture.dir, prog: fixture.prog, pid: fixture.pid, startedAt: "Wed Nov  2 09:04:00 2026", timeoutMs: 5000 }), true);
    assert.equal(await runDarwinWatchdogCase({ dir: fixture.dir, prog: fixture.prog, pid: fixture.pid, startedAt: "Wed Nov  2 09:05:00 2026", timeoutMs: 1500 }), false);
  } finally {
    await fixture.cleanup();
  }
}, 20_000);

// oxlint-disable-next-line eslint/max-statements -- One terminal: how it was started, then its output and keys.
test("the terminal is its own process group in the work directory; keys go to it and its output comes back", () => {
  const { host, child, spawned } = fakeHost();
  const terminal = opened(openScriptTerminal(INPUT, host));
  assert.equal(spawned.length, 1);
  const [started] = spawned;
  assert.ok(started);
  assert.equal(started.options.cwd, "/work");
  assert.equal(started.options.detached, true);
  assert.equal(started.options.env?.SHELL, "/bin/sh");
  const seen: string[] = [];
  terminal.onData((chunk) => { seen.push(chunk); });
  // A character cut in two by the pipe is put back together.
  const bytes = Buffer.from("❯ ok");
  child.stdout.emit("data", bytes.subarray(0, 2));
  child.stdout.emit("data", bytes.subarray(2));
  assert.equal(seen.join(""), "❯ ok");
  terminal.write("/limit-reset weekly");
  assert.deepEqual(child.stdin.written, ["/limit-reset weekly"]);
  void terminal.kill();
});

test("no script utility: no terminal, nothing started", () => {
  const { host, spawned } = fakeHost({ noScript: true });
  assert.equal(openScriptTerminal(INPUT, host), null);
  assert.equal(spawned.length, 0);
});

// oxlint-disable-next-line eslint/max-statements -- One kill, followed from the first signal to the last process gone.
test("kill ends the program and its children, not only script, and resolves once they are gone", async () => {
  const { host, signals, table } = fakeHost();
  const terminal = opened(openScriptTerminal(INPUT, host));
  let exited = false;
  terminal.onExit(() => { exited = true; });
  let done = false;
  const killing = (async (): Promise<void> => {
    await terminal.kill();
    done = true;
  })();
  assert.deepEqual(signals, [[101, "SIGTERM"], [102, "SIGTERM"], [103, "SIGTERM"], [-100, "SIGTERM"]], "the tree under script, then script's own group");
  assert.equal(done, false, "not before they are gone");
  await vi.advanceTimersByTimeAsync(200);
  await killing;
  assert.equal(exited, true);
  assert.deepEqual(table().map((each) => each.pid), [1, 50, 200], "nothing else on the host was touched");
  assert.ok(!signals.some(([, signal]) => signal === "SIGKILL"), "they went when asked");
  assert.equal(terminal.kill(), terminal.kill(), "asking again is the same wait");
});

// oxlint-disable-next-line eslint/max-statements -- One kill, with a process started part way through it.
test("a process that ignores the request, or starts after it, is killed outright; the wait is bounded", async () => {
  const { host, signals, table, add } = fakeHost({ ignoresTerm: [101, 103] });
  const terminal = opened(openScriptTerminal(INPUT, host));
  const killing = terminal.kill();
  await vi.advanceTimersByTimeAsync(500);
  add({ pid: 104, parentPid: 101, startedAt: "14" });
  await vi.advanceTimersByTimeAsync(4000);
  await killing;
  const killed = signals.filter(([, signal]) => signal === "SIGKILL").map(([pid]) => pid);
  assert.deepEqual([...new Set(killed.filter((pid) => pid > 0))].toSorted((left, right) => left - right), [101, 103, 104]);
  assert.ok(killed.includes(-100), "and script's group");
  assert.deepEqual(table().map((each) => each.pid), [1, 50, 200]);
});

test("a pid that now belongs to another process is left alone", async () => {
  const fake = fakeHost({ ignoresTerm: [103] });
  const terminal = opened(openScriptTerminal(INPUT, fake.host));
  const killing = terminal.kill();
  await vi.advanceTimersByTimeAsync(100);
  // 102 is gone, so 103 is no longer under script; then its pid is taken by something unrelated.
  fake.host.listProcesses = () => [...fake.table().filter((each) => each.pid !== 103), { pid: 103, parentPid: 1, startedAt: "999" }];
  await vi.advanceTimersByTimeAsync(4000);
  await killing;
  assert.ok(!fake.signals.some(([pid, signal]) => pid === 103 && signal === "SIGKILL"));
});

/** The program (101, its own group) and a child in that group (102), seen while running; then script and the program exit. */
// oxlint-disable-next-line eslint/max-statements -- One early exit, from the first look to the kill.
async function afterEarlyExit(later: (table: TerminalProcess[]) => TerminalProcess[]) {
  const fake = fakeHost();
  let table: TerminalProcess[] = [
    { pid: 50, parentPid: 1, startedAt: "5", groupId: 50 },
    { pid: 100, parentPid: 50, startedAt: "10", groupId: 100 },
    { pid: 101, parentPid: 100, startedAt: "11", groupId: 101 },
    { pid: 102, parentPid: 101, startedAt: "12", groupId: 101 },
  ];
  fake.host.listProcesses = () => table;
  const marked: string[] = [];
  fake.host.killMarked = async (entry) => { marked.push(entry); };
  const terminal = opened(openScriptTerminal(INPUT, fake.host));
  terminal.onData(() => {});
  // Output prompts a look at the processes below script.
  fake.child.stdout.emit("data", Buffer.from("❯"));
  await vi.advanceTimersByTimeAsync(600);
  // script and the program are gone; what is left was reparented, then `later` changes the table.
  table = later([{ pid: 50, parentPid: 1, startedAt: "5", groupId: 50 }, { pid: 102, parentPid: 1, startedAt: "12", groupId: 101 }]);
  fake.child.emit("exit", 0, null);
  const killing = terminal.kill();
  await vi.advanceTimersByTimeAsync(5000);
  await killing;
  return { signalled: new Set(fake.signals.map(([pid]) => pid)), marked };
}

test("after the program exits first: its group, while a process seen earlier is still in it, is ended", async () => {
  const { signalled, marked } = await afterEarlyExit((left) => [...left, { pid: 103, parentPid: 1, startedAt: "13", groupId: 101 }]);
  assert.ok(signalled.has(102), "the child seen while running");
  assert.ok(signalled.has(103), "and one started in the same group since");
  assert.equal(marked.length, 1, "and the environment marker is scanned");
});

test("after the program exits first: a reused group id or script pid is left alone", async () => {
  // Every original member is gone; a new group took id 101, and a new process took script's pid 100 and has a child.
  const { signalled } = await afterEarlyExit(() => [
    { pid: 50, parentPid: 1, startedAt: "5", groupId: 50 },
    { pid: 101, parentPid: 1, startedAt: "90", groupId: 101 },
    { pid: 104, parentPid: 101, startedAt: "91", groupId: 101 },
    { pid: 100, parentPid: 1, startedAt: "92", groupId: 100 },
    { pid: 105, parentPid: 100, startedAt: "93", groupId: 100 },
  ]);
  for (const pid of [101, 104, 100, 105, -100]) { assert.ok(!signalled.has(pid), String(pid)); }
});
