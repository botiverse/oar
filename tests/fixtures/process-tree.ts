import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** The stand-in agent (fake-agent-process.mjs): run it with `process.execPath`. */
export const fakeAgent = fileURLToPath(new URL("fake-agent-process.mjs", import.meta.url));
/** The process-tree module alone, for `node --import` into another fixture. */
export const agentTreeModule = new URL("agent-tree.mjs", import.meta.url).href;

/** The pids a fake agent reports (agent-tree.mjs): itself, and the tool it started. */
export interface AgentTree {
  readonly agent: number;
  readonly grandchild: number;
}

/** One fake agent's scratch directory: the env that grows its tree, and where it reports it. */
export interface TreeProbe {
  readonly dir: string;
  readonly env: Readonly<Record<string, string>>;
  /** The reported pids, once the grandchild runs. */
  tree(): Promise<AgentTree>;
  /** The pid of the tool the agent started on SIGTERM (`lateTool`), once it runs. */
  lateTool(): Promise<number>;
}

/** How the fake agent behaves (agent-tree.mjs): see the env switches there. */
export interface TreeProbeOptions {
  readonly ignoreSigterm: boolean;
  /** Its tool runs in a session of its own (POSIX). */
  readonly detachTool?: boolean;
  /** With `ignoreSigterm`: the SIGTERM starts one more tool, in a session of its own. */
  readonly lateTool?: boolean;
}

/** `process.kill` found no such process. */
function noSuchProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !noSuchProcess(error);
  }
}

/** Poll `predicate` until it holds; false when the deadline passes first. */
export async function eventually(predicate: () => boolean, withinMs: number): Promise<boolean> {
  const deadline = performance.now() + withinMs;
  while (!predicate()) {
    if (performance.now() > deadline) {
      return false;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling: each wait follows the previous check
    await delay(20);
  }
  return true;
}

/** Poll `process.kill(pid, 0)` until it answers ESRCH; false when the pid outlives the deadline. */
export async function gone(pid: number, withinMs = 5000): Promise<boolean> {
  return eventually(() => !alive(pid), withinMs);
}

/** How long `work` takes to settle, in milliseconds. */
export async function timed(work: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await work();
  return performance.now() - started;
}

/**
 * Run `body` with a scratch directory whose env makes a fake agent grow its
 * tree; afterwards SIGKILL whatever the agent reported and is still alive (a
 * failed test must not leak) and remove the directory.
 */
export async function withTreeProbe<Result>(
  options: TreeProbeOptions,
  body: (probe: TreeProbe) => Promise<Result>,
): Promise<Result> {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-process-tree-"));
  const pidFile = path.join(dir, "pids.json");
  const lateFile = path.join(dir, "late.pid");
  const reported: number[] = [];
  try {
    return await body({
      dir,
      env: {
        OAR_FIXTURE_PIDS: pidFile,
        ...(options.ignoreSigterm ? { OAR_FIXTURE_IGNORE_SIGTERM: "1" } : {}),
        ...(options.detachTool === true ? { OAR_FIXTURE_DETACH_TOOL: "1" } : {}),
        ...(options.lateTool === true ? { OAR_FIXTURE_LATE_TOOL: lateFile } : {}),
      },
      async tree() {
        if (!await eventually(() => existsSync(pidFile), 10_000)) {
          throw new Error(`the fake agent never reported its pids in ${pidFile}`);
        }
        // The fixture renames a complete file into place, so one read suffices.
        // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Shape written by agent-tree.mjs.
        const tree = JSON.parse(readFileSync(pidFile, "utf8")) as AgentTree;
        reported.push(tree.agent, tree.grandchild);
        return tree;
      },
      async lateTool() {
        if (!await eventually(() => existsSync(lateFile), 10_000)) {
          throw new Error(`the fake agent never reported a late tool in ${lateFile}`);
        }
        const pid = Number(readFileSync(lateFile, "utf8"));
        reported.push(pid);
        return pid;
      },
    });
  } finally {
    // Started on a SIGTERM the test may not have got to look at.
    if (existsSync(lateFile)) {
      reported.push(Number(readFileSync(lateFile, "utf8")));
    }
    reap(reported, dir);
  }
}

/** SIGKILL whatever of `pids` is still alive and remove `dir`. */
function reap(pids: readonly number[], dir: string): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      // Already gone, possibly only just: a dispose may still be ending the
      // tree, so a check for life before the signal can pass and still miss.
      if (!noSuchProcess(error)) {
        throw error;
      }
    }
  }
  // Windows releases a killed process's open files a moment after the kill,
  // so the removal can meet EPERM; rmSync retries that (and EBUSY) itself.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * An adapter's installation.command. POSIX exec keeps the agent's pid;
 * Windows deliberately keeps a .cmd launcher, so killing only that wrapper
 * cannot pass the agent/descendant liveness assertions.
 */
export function fakeAgentBinary(dir: string, entry: readonly string[] = [fakeAgent]): string {
  const windows = process.platform === "win32";
  const binary = path.join(dir, windows ? "fake-agent.cmd" : "fake-agent");
  const command = [process.execPath, ...entry].map((arg) => `"${arg}"`).join(" ");
  writeFileSync(binary, windows ? `@echo off\r\n${command} %*\r\n` : `#!/bin/sh\nexec ${command} "$@"\n`);
  chmodSync(binary, 0o755);
  return binary;
}
