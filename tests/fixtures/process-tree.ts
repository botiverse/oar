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
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
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
  options: { readonly ignoreSigterm: boolean },
  body: (probe: TreeProbe) => Promise<Result>,
): Promise<Result> {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-process-tree-"));
  const pidFile = path.join(dir, "pids.json");
  const reported: number[] = [];
  try {
    return await body({
      dir,
      env: { OAR_FIXTURE_PIDS: pidFile, ...(options.ignoreSigterm ? { OAR_FIXTURE_IGNORE_SIGTERM: "1" } : {}) },
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
    });
  } finally {
    for (const pid of reported) {
      if (alive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
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
