import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { environmentHome } from "../../shared/environment-home.js";
import { environmentValue } from "../../shared/environment.js";

/** DSH expands tilde against the child home and resolves relative overrides against its cwd. */
function profileDirectory(env: NodeJS.ProcessEnv, cwd: string): string {
  const userHome = environmentHome(env);
  const configured = environmentValue(env, "DSH_HOME");
  let home = configured === undefined || configured.trim() === "" ? path.join(userHome, ".dsh") : configured;
  if (home === "~") { home = userHome; }
  else if (home.startsWith("~/") || home.startsWith("~\\")) { home = path.join(userHome, home.slice(2)); }
  return path.resolve(cwd, home, "profiles", "acp");
}

/** Shared with the caller so its deadline can describe the current stage of the read. */
export interface DshProfileWait {
  blocked?: { directory: string; since: number };
}

export function profileWaitReason(state: DshProfileWait): string | undefined {
  const blocked = state.blocked;
  if (blocked === undefined) { return undefined; }
  return `Waited ${String(Math.round(performance.now() - blocked.since))} ms for another DSH start to release the profile lock in ${blocked.directory}`;
}

/** A SQLite write transaction holds an OS file lock across processes, including on Windows.
 * The empty database stays in place. Closing the connection or losing the owner releases the lock. */
export async function acquireDshProfile(env: NodeJS.ProcessEnv, cwd: string, signal?: AbortSignal, state: DshProfileWait = {}): Promise<() => void> {
  signal?.throwIfAborted();
  const directory = profileDirectory(env, cwd);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(directory, ".oar-startup.sqlite"));
  try {
    for (;;) {
      signal?.throwIfAborted();
      try {
        db.exec("BEGIN IMMEDIATE");
        delete state.blocked;
        return () => { if (db.isOpen) { db.close(); } };
      } catch (error) {
        // SQLITE_BUSY means another connection owns the write lock. No DSH child has been started.
        if (!(error instanceof Error && "errcode" in error && error.errcode === 5)) { throw error; }
        state.blocked ??= { directory, since: performance.now() };
      }
      // oxlint-disable-next-line no-await-in-loop -- Wait for the OS lock without blocking the host event loop.
      await wait(25, undefined, { signal });
    }
  } catch (error) {
    db.close();
    if (signal?.aborted === true && state.blocked !== undefined) {
      const reason: unknown = signal.reason;
      throw new DOMException(`${profileWaitReason(state)}: ${reason instanceof Error ? reason.message : String(reason)}`, reason instanceof Error ? reason.name : "AbortError");
    }
    throw error;
  }
}
