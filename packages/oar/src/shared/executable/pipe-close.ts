import type { ChildProcess } from "node:child_process";
import type { Stream } from "node:stream";
import type { HeldPipe, HeldPipes } from "./process-cleanup-diagnostics.js";
import { ownLeftProcesses } from "./ownership.js";
import { observeProcessTableAsync, processTableSource } from "./process-table-async.js";
import { processTableFailure, type ProcessTableObservation } from "./process-tree.js";

/*
 * A process the root started can keep the root's output pipes open after the
 * root exits: a background job, or, when the root runs the runtime as another
 * user (a `sudo -u` wrapper), the whole tree a SIGKILL to sudo orphaned,
 * which OAR may not signal. Node emits the child's `close` only once every
 * pipe is at EOF, so waiting for it would wait as long as those processes
 * live. After the root's exit OAR waits a bounded time; then it closes its
 * end of each pipe still held and reports what it can see of the holders.
 * POSIX only: Windows keeps waiting for `close` as before.
 */

/** After the root exits, how long a process it left may keep its output pipes open before OAR closes its end. */
export const PIPE_CLOSE_MS = 2000;

/** How often a pipe left to its reader (unread data) is looked at again once the limit has passed. */
const PAUSED_RECHECK_MS = 100;

type Pipe = Stream & { destroy(): void; readonly destroyed: boolean; readonly closed?: boolean; readonly readableFlowing?: boolean | null; readonly readableLength?: number };
export interface NamedPipe { readonly name: HeldPipe; readonly stream: Pipe | null | undefined }
type OpenPipe = NamedPipe & { readonly stream: Pipe };

const isClosed = (pipe: Pipe): boolean => pipe.destroyed || pipe.closed === true;
/**
 * Data its reader has not taken yet: closing OAR's end would lose it. Only a
 * reader that is not taking data now leaves any: `readableFlowing` alone is
 * false for a `for await` or `'readable'` reader too, which reads normally.
 */
const unread = (pipe: Pipe): boolean => pipe.readableFlowing === false && (pipe.readableLength ?? 0) > 0;

/** Still open past the limit with nothing left for its reader: some process holds it. */
const isHeld = (pipe: Pipe): boolean => !isClosed(pipe) && !unread(pipe);

async function observeTable(): Promise<ProcessTableObservation> {
  try { return await observeProcessTableAsync(); }
  catch (error) { return processTableFailure(error, processTableSource(), 0); }
}

/** Close OAR's end of `held`, owning the processes in the root's group as their holders (by pid and start). */
async function closeHeld(child: ChildProcess, root: number, held: readonly OpenPipe[], started: number): Promise<HeldPipes> {
  const table = await observeTable();
  const group = table.ok ? [...table.table.values()].filter((entry) => entry.pgid === root && entry.pid !== process.pid) : [];
  // What the host-exit hook then ends as if the pipes were open: each only while it is the same process.
  ownLeftProcesses(child, group);
  for (const pipe of held) { pipe.stream.destroy(); }
  return {
    waitedMs: Math.round(performance.now() - started),
    pipes: held.map((pipe) => pipe.name),
    holders: group.map((entry) => entry.pid).toSorted((a, b) => a - b),
    ...(table.ok ? {} : { observation: { ...table, phase: "pipe_holders" as const } }),
  };
}

/** Two reports of held pipes as one: every pipe and holder, the longer wait, the first failed read. */
export function mergeHeldPipes(one: HeldPipes | undefined, other: HeldPipes | undefined): HeldPipes | undefined {
  if (one === undefined || other === undefined) { return one ?? other; }
  const observation = one.observation ?? other.observation;
  return {
    waitedMs: Math.max(one.waitedMs, other.waitedMs),
    pipes: [...new Set([...one.pipes, ...other.pipes])],
    holders: [...new Set([...one.holders, ...other.holders])].toSorted((a, b) => a - b),
    ...(observation === undefined ? {} : { observation }),
  };
}

/**
 * Once `child` has exited: wait up to `limitMs` for `pipes` (its stdout,
 * stderr and any extra pipe) to close. Undefined when they did, or when the
 * only ones still open hold data their reader has not taken yet. A pipe OAR
 * is still reading that has not reached its end is held by some process,
 * whether or not one can be named; OAR closes its end of each such pipe, and
 * only of those. A pipe with unread data is left to its reader until it has
 * taken that data: if the pipe is still open then, OAR closes it too and
 * passes that report to `onLater` (a reader that never takes it keeps it,
 * as before this limit). The processes still in the root's process group
 * are reported as the holders (which pipe each holds is not known; one
 * outside the group, such as another user's that left it, is not seen), and
 * owned by their identity (pid and start) for the host's exit hook
 * (ownership.ts). Never throws: a failed table read still closes the pipes
 * and is reported.
 */
export async function closePipesAfterExit(child: ChildProcess, pipes: readonly NamedPipe[], limitMs: number = PIPE_CLOSE_MS, onLater?: (held: HeldPipes) => void): Promise<HeldPipes | undefined> {
  const open = pipes.filter((pipe): pipe is OpenPipe => pipe.stream !== null && pipe.stream !== undefined && !isClosed(pipe.stream));
  const root = child.pid;
  // Windows has no process groups to name holders by, and taskkill ends the tree.
  if (open.length === 0 || root === undefined || process.platform === "win32") { return undefined; }
  const started = performance.now();
  const closed = Promise.all(open.map(async ({ stream }) => {
    if (isClosed(stream)) { return; }
    await new Promise<void>((resolve) => { stream.once("close", () => { resolve(); }); });
  }));
  let timer: NodeJS.Timeout | undefined = undefined;
  const expired = new Promise<"expired">((resolve) => { timer = setTimeout(() => { resolve("expired"); }, limitMs); });
  const outcome = await Promise.race([closed, expired]);
  clearTimeout(timer);
  if (outcome !== "expired") { return undefined; }
  const waiting = open.filter((pipe) => !isClosed(pipe.stream) && unread(pipe.stream));
  if (waiting.length > 0) { closeOnceTaken(child, root, waiting, started, onLater); }
  const held = open.filter((pipe) => isHeld(pipe.stream));
  if (held.length === 0) { return undefined; }
  const report = await closeHeld(child, root, held, started);
  return report;
}

/*
 * A reader takes its data with no event OAR could listen for without
 * changing how the stream flows (a `'data'` listener would make it flow once
 * the reader drops its `'readable'` one), so the pipes are looked at again
 * on a timer. It is unref'd: the open pipes are what keeps the process up.
 */
function closeOnceTaken(child: ChildProcess, root: number, waiting: readonly OpenPipe[], started: number, onLater: ((held: HeldPipes) => void) | undefined): void {
  let pending = [...waiting];
  const recheck = setInterval(() => {
    const taken = pending.filter((pipe) => isHeld(pipe.stream));
    pending = pending.filter((pipe) => !isClosed(pipe.stream) && unread(pipe.stream));
    if (pending.length === 0) { clearInterval(recheck); }
    if (taken.length === 0) { return; }
    void (async (): Promise<void> => {
      const held = await closeHeld(child, root, taken, started);
      onLater?.(held);
    })();
  }, PAUSED_RECHECK_MS);
  recheck.unref();
}
