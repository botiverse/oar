import { closeSync, constants, lstatSync, openSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/*
 * Temporary directories oar makes for one runtime process (claude's MCP
 * config, opencode's appended prompt): `<prefix><host pid>-XXXXXX` in the
 * system temporary directory, mode 0700. Their owner removes them when the
 * process ends. Two backstops for a host that ends without disposing its
 * sessions: every directory still present is removed synchronously on the
 * host's `exit` event (`process.exit()`, an uncaught exception, an emptied
 * event loop; a signal that kills the host fires none), and making the next
 * directory with the same prefix (or `sweepPrivateTempDirs`) first removes
 * those whose host pid no longer runs. A pid the system has given to another process since keeps its
 * directory until that process ends too; this host's own pid is never swept,
 * since a directory another session of it is making may not be registered yet.
 *
 * Every removal first releases a reader blocked opening a FIFO in the
 * directory (claude waiting for its MCP config): a writer opens and closes at
 * once, so the reader reads an empty document and fails instead of waiting
 * forever, which unlinking the FIFO alone would leave it doing.
 */

/** A directory `privateTempDir` made: its path, and its removal (synchronous, idempotent). */
export interface PrivateTempDir {
  readonly path: string;
  remove(): void;
}

const live = new Set<string>();
let hooked = false;

function releaseFifos(directory: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      if (lstatSync(file).isFIFO()) {
        closeSync(openSync(file, constants.O_WRONLY | constants.O_NONBLOCK));
      }
    } catch {
      // ENXIO: no reader is waiting.
    }
  }
}

function removeDirectory(directory: string): void {
  releaseFifos(directory);
  rmSync(directory, { recursive: true, force: true });
}

function removeLive(): void {
  for (const directory of live) {
    removeDirectory(directory);
  }
  live.clear();
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid runs, as another user.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Remove `prefix` directories whose host pid no longer runs, releasing their FIFOs first; one that cannot be removed (another user's) stays. */
export async function sweepPrivateTempDirs(prefix: string): Promise<void> {
  const root = tmpdir();
  const names = await readdir(root).catch((): string[] => []);
  await Promise.all(names.map(async (name) => {
    const pid = name.startsWith(prefix) ? /^(\d+)-/u.exec(name.slice(prefix.length))?.[1] : undefined;
    if (pid === undefined || Number(pid) === process.pid || running(Number(pid))) {
      return;
    }
    const directory = path.join(root, name);
    releaseFifos(directory);
    await rm(directory, { recursive: true, force: true }).catch((): undefined => undefined);
  }));
}

/** A fresh 0700 directory for one runtime process, removed by `remove()` or, failing that, by the backstops above. */
export async function privateTempDir(prefix: string): Promise<PrivateTempDir> {
  await sweepPrivateTempDirs(prefix);
  const directory = await mkdtemp(path.join(tmpdir(), `${prefix}${String(process.pid)}-`));
  if (!hooked) {
    process.on("exit", removeLive);
    hooked = true;
  }
  live.add(directory);
  return {
    path: directory,
    remove: () => {
      live.delete(directory);
      removeDirectory(directory);
    },
  };
}
