import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import { createCursorRuntime, type CursorRuntime } from "../../packages/oar/src/index.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { parseCursorChildSpec } from "../../packages/oar/src/runtimes/cursor/subprocess/child-runner.js";
import { alive, signalFixture } from "../fixtures/process-tree.js";
import {
  bundled,
  FAKE_SDK_MODULE,
  lastResult,
  printEnvironment,
  reportedProcesses,
  responsesOf,
  tempDirectory,
  until,
} from "../fixtures/cursor-subprocess.js";

const childEntry = path.join(import.meta.dirname, "../fixtures/cursor-child-entry.ts");
const sourceRoot = path.join(import.meta.dirname, "../../packages/oar/src");
const childLauncher = {
  command: process.execPath,
  args: ["--import", "tsx", childEntry, "--cursor-child"],
} as const;

function customRuntime(envBase: "inherit" | "clean" = "inherit"): CursorRuntime {
  return createCursorRuntime({
    execution: "subprocess",
    sdkModule: FAKE_SDK_MODULE,
    envBase,
    childProcess: childLauncher,
  });
}

test("empty or whitespace childProcess.command is rejected synchronously", () => {
  expect(() => createCursorRuntime({ execution: "subprocess", sdkModule: FAKE_SDK_MODULE, childProcess: { command: "" } }))
    .toThrow(/childProcess\.command/u);
  expect(() => createCursorRuntime({ execution: "subprocess", sdkModule: FAKE_SDK_MODULE, childProcess: { command: "   " } }))
    .toThrow(/childProcess\.command/u);
});

// oxlint-disable-next-line eslint/max-statements -- Checks both missing IPC and every malformed spec field.
test("runCursorChild fails fast without IPC and rejects malformed specs", async () => {
  const noIpc = spawnSync(
    process.execPath,
    ["--import", "tsx", childEntry, "--cursor-child", JSON.stringify([FAKE_SDK_MODULE, 1000, false, null, "M=1"])],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 },
  );
  expect(noIpc.status).not.toBe(0);
  expect(noIpc.stderr).toMatch(/IPC/u);

  expect(() => parseCursorChildSpec("")).toThrow(/non-empty/u);
  expect(() => parseCursorChildSpec("{}")).toThrow(/malformed/u);
  expect(() => parseCursorChildSpec(JSON.stringify(["", 1000, false, null, "M=1"]))).toThrow(/sdkModule/u);
  expect(() => parseCursorChildSpec(JSON.stringify([FAKE_SDK_MODULE, -1, false, null, "M=1"]))).toThrow(/graceMs/u);
  expect(() => parseCursorChildSpec(JSON.stringify([FAKE_SDK_MODULE, 1000, 123, null, "M=1"]))).toThrow(/electron/u);
  expect(() => parseCursorChildSpec(JSON.stringify([FAKE_SDK_MODULE, 1000, false, null, ""]))).toThrow(/marker/u);

  const probeDone = Promise.withResolvers<{ readonly code: number | null; readonly stderr: string }>();
  const child = spawn(process.execPath, ["--import", "tsx", childEntry, "--cursor-child", "not-json"], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.once("close", (code) => { probeDone.resolve({ code, stderr }); });
  const probe = await probeDone.promise;
  expect(probe.code).not.toBe(0);
  expect(probe.stderr).toMatch(/malformed|spec/iu);
});

// oxlint-disable-next-line eslint/max-statements -- End-to-end open, turn, steer, abort, and dispose through childProcess + runCursorChild.
test("childProcess + runCursorChild supports open, turn, steer, abort, and dispose with async close", async () => {
  const closed = path.join(tempDirectory(), "closed");
  const session = await customRuntime().session(bundled, {
    cwd: tempDirectory(),
    model: "composer",
    env: { OAR_FAKE_CURSOR_CLOSED: closed },
  });
  try {
    expect(session.placement).toBe("isolated");
    const first = await session.prompt("echo:PELICAN");
    expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "completed" });
    expect(lastResult(session)).toBe("PELICAN");

    const held = await session.prompt("hold");
    if (session.steer === undefined) { throw new Error("expected cursor session to support steer"); }
    const steer = await session.steer("also PELICAN");
    expect(steer.response.body).toEqual({ kind: "accepted", native: { ack: "complete_delivered" } });
    // Queued steer with a throwing `.run` getter must not access or serialize `.run`.
    const queued = await session.steer("native-queued-with-run");
    expect(queued.response.body).toEqual({ kind: "accepted", native: { ack: "queued" } });
    await session.abort();
    expect(await awaitTurnEnd(session, held.seq)).toMatchObject({ kind: "aborted" });
  } finally {
    await session.dispose();
  }
  expect(responsesOf(session, "exited")).toEqual([{ kind: "exited", code: 0 }]);
  expect(existsSync(closed)).toBe(true);
});

// oxlint-disable-next-line eslint/max-statements -- Simulated Node SEA host checking listModels, authStatus, and session round-trip.
test("childProcess + runCursorChild runs in a simulated Node SEA host and answers one-shot listModels/authStatus", async () => {
  const builtin = process.getBuiltinModule.bind(process);
  const spy = vi.spyOn(process, "getBuiltinModule").mockImplementation((id: string) => (id === "node:sea" ? { isSea: () => true } : builtin(id)));
  try {
    const runtime = customRuntime();
    expect(await runtime.listModels(bundled)).toMatchObject({ kind: "ok" });
    expect(await runtime.authStatus(bundled)).toMatchObject({ kind: "logged_out" });
    const session = await runtime.session(bundled, { cwd: tempDirectory() });
    try {
      const prompt = await session.prompt("echo:SEA");
      expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "completed" });
      expect(lastResult(session)).toBe("SEA");
    } finally {
      await session.dispose();
    }
  } finally {
    spy.mockRestore();
  }
});

// oxlint-disable-next-line eslint/max-statements -- Crash + descendant cleanup check through childProcess + runCursorChild.
test("childProcess + runCursorChild records child crashes and ends descendant tools", async () => {
  const session = await customRuntime().session(bundled, { cwd: tempDirectory(), model: "composer" });
  const pidFile = path.join(tempDirectory(), "pids.json");
  const toolPrompt = await session.prompt(`spawn:${pidFile}`);
  await awaitTurnEnd(session, toolPrompt.seq);
  const pids = reportedProcesses(pidFile);

  const crashPrompt = await session.prompt("throw");
  await awaitTurnEnd(session, crashPrompt.seq);
  const [exited] = responsesOf(session, "exited");
  expect(exited).toMatchObject({ kind: "exited", code: 1 });
  expect(JSON.stringify(exited)).toContain("fake SDK failure");

  await until(() => !alive(pids.child) && !alive(pids.grandchild));
  expect({ child: alive(pids.child), grandchild: alive(pids.grandchild) }).toEqual({ child: false, grandchild: false });
  await session.dispose();
});

test("childProcess + runCursorChild honors envBase: clean without injecting ELECTRON_RUN_AS_NODE", async () => {
  const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  const session = await customRuntime("clean").session(bundled, {
    cwd: tempDirectory(),
    env: { ...baseEnv, CUSTOM_FLAG: "yes" },
  });
  try {
    const prompt = await session.prompt(`shell:${printEnvironment(["CUSTOM_FLAG", "ELECTRON_RUN_AS_NODE"])}`);
    await awaitTurnEnd(session, prompt.seq);
    const parsed: unknown = JSON.parse(String(lastResult(session)));
    expect(parsed).toEqual(["yes", null]);
  } finally {
    await session.dispose();
  }
});

test("childProcess + runCursorChild preserves an explicit ELECTRON_RUN_AS_NODE value untouched", async () => {
  const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  const session = await customRuntime("clean").session(bundled, {
    cwd: tempDirectory(),
    env: { ...baseEnv, ELECTRON_RUN_AS_NODE: "custom-value" },
  });
  try {
    const prompt = await session.prompt(`shell:${printEnvironment(["ELECTRON_RUN_AS_NODE"])}`);
    await awaitTurnEnd(session, prompt.seq);
    const parsed: unknown = JSON.parse(String(lastResult(session)));
    expect(parsed).toEqual(["custom-value"]);
  } finally {
    await session.dispose();
  }
});

// oxlint-disable-next-line eslint/max-statements -- Host SIGKILL orphan cleanup with custom childProcess + runCursorChild.
test("a SIGKILLed host using childProcess + runCursorChild still closes its agent and stops its tool", async () => {
  const dir = tempDirectory();
  const pidFile = path.join(dir, "pids.json");
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", OAR_FAKE_CURSOR_CLOSED: path.join(dir, "closed") };
  const hostScript = `import { createCursorRuntime } from ${JSON.stringify(pathToFileURL(path.join(sourceRoot, "index.ts")).href)};
import { awaitTurnEnd } from ${JSON.stringify(pathToFileURL(path.join(sourceRoot, "observe/turns.ts")).href)};
const runtime = createCursorRuntime({
  execution: "subprocess",
  sdkModule: ${JSON.stringify(FAKE_SDK_MODULE)},
  envBase: "clean",
  childProcess: ${JSON.stringify(childLauncher)},
});
const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: ${JSON.stringify(dir)}, env: ${JSON.stringify(env)} });
const prompt = await session.prompt(${JSON.stringify(`spawn:${pidFile}`)});
await awaitTurnEnd(session, prompt.seq);
process.kill(process.pid, "SIGKILL");`;
  const host = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", hostScript], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, OAR_KILL_GRACE_MS: "2000" },
  });
  const { child, grandchild } = reportedProcesses(pidFile);
  try {
    expect(process.platform === "win32" ? { status: host.status, stderr: host.stderr } : { signal: host.signal, stderr: host.stderr })
      .toEqual(process.platform === "win32" ? { status: 1, stderr: "" } : { signal: "SIGKILL", stderr: "" });
    await until(() => !alive(child) && !alive(grandchild), 10_000);
    expect({ child: alive(child), grandchild: alive(grandchild) }).toEqual({ child: false, grandchild: false });
    expect(existsSync(path.join(dir, "closed"))).toBe(true);
  } finally {
    for (const pid of [child, grandchild]) { signalFixture(pid); }
  }
});
