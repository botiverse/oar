import { afterEach, expect, test } from "vitest";
import { spawnLineProcess, type LineProcess } from "../packages/oar/src/shared/executable/process.js";
import { eventually, reportedProcess, reportShellChild, type ProcessIdentity, signalFixture } from "./fixtures/process-tree.js";

// Which of an exited root's pipes OAR closes depends on its reader
// (pipe-close.ts): only data the reader has not taken yet keeps a pipe open
// past the limit, and only until the reader takes it. A `for await` or
// `'readable'` reader has `readableFlowing` false while it reads normally.
// The bounded wait itself: process-held-pipes.test.ts.
const posix = process.platform !== "win32";
const started: ProcessIdentity[] = [];

afterEach(() => {
  for (const pid of started.splice(0)) { signalFixture(pid); }
});

/** `heldPipes` with its timing reduced to its type, to compare the rest exactly. */
const shape = <T extends { readonly waitedMs: number }>(held: T | undefined): (Omit<T, "waitedMs"> & { readonly waitedMs: string }) | undefined =>
  held === undefined ? held : { ...held, waitedMs: typeof held.waitedMs };

/** A line process with a private pipe running `sh args`, once it printed its holder's pid. */
async function withHolder(args: readonly string[]): Promise<{ readonly child: LineProcess; readonly extra: NonNullable<LineProcess["extraPipe"]>; readonly holder: number }> {
  const child = spawnLineProcess("sh", args, { killTree: true, extraPipe: true });
  const extra = child.extraPipe;
  if (extra === undefined) { throw new Error("no extra pipe"); }
  const printed = Promise.withResolvers<string>();
  child.onLine((line) => { printed.resolve(line); });
  const holder = reportedProcess(JSON.parse(await printed.promise));
  started.push(holder);
  return { child, extra, holder: holder.pid };
}

/** A chunk read from a pipe as text. */
const asText = (chunk: unknown): string => (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "");

/** Everything a `for await` loop reads, waiting on `busy` after each chunk; a premature close (OAR closed its end) ends it. */
async function readAll(extra: AsyncIterable<unknown>, busy: Promise<void> = Promise.resolve()): Promise<string> {
  let text = "";
  try {
    for await (const chunk of extra) {
      text += asText(chunk);
      await busy;
    }
  } catch { /* Premature close. */ }
  return text;
}

/** The root leaves a holder on its private pipe only, which writes `first` and then `second` after the root has exited; the root prints its pid and exits. */
const leaveLateWriter = ["-c", `(sleep 0.3; printf first >&3; sleep 0.3; printf second >&3; exec sleep 60) >/dev/null 2>&1 & ${reportShellChild}; exit 0`];
/**
 * The root leaves a holder on its private pipe only (stdout and stderr close), prints its pid and exits.
 * The redirect is on a subshell that execs `sleep`: a shell that runs `sleep` itself (an applet as a
 * builtin) keeps saved copies of the redirected stdout and stderr open in the holder, so they would
 * really be held.
 */
const leaveExtraHolder = ["-c", `printf data >&3; (exec sleep 60) >/dev/null 2>&1 & ${reportShellChild}; exit 0`];

// Review round 2 (B5): `readableFlowing` is false for a reader that reads normally too; only unread data keeps a pipe open.
test.skipIf(!posix)("a pipe a `for await` reader is reading is closed like any other held pipe", async () => {
  const { child, extra, holder } = await withHolder(leaveExtraHolder);
  const read = readAll(extra);
  expect(await child.exited).toBe(0);
  expect({ closed: extra.destroyed, heldPipes: shape(child.diagnostics().cleanup?.heldPipes), read: await read })
    .toEqual({ closed: true, heldPipes: { waitedMs: "number", pipes: ["extra"], holders: [holder] }, read: "data" });
});

test.skipIf(!posix)("a pipe a `'readable'` reader is reading is closed like any other held pipe", async () => {
  const { child, extra, holder } = await withHolder(leaveExtraHolder);
  let text = "";
  extra.on("readable", () => { for (let chunk: unknown = extra.read(); chunk !== null; chunk = extra.read()) { text += asText(chunk); } });
  expect(await child.exited).toBe(0);
  expect({ closed: extra.destroyed, heldPipes: shape(child.diagnostics().cleanup?.heldPipes), text })
    .toEqual({ closed: true, heldPipes: { waitedMs: "number", pipes: ["extra"], holders: [holder] }, text: "data" });
});

test.skipIf(!posix)("a pipe left to a reader that paused with data unread is closed once it resumes and takes that data, and joins the report", async () => {
  const { child, extra, holder } = await withHolder(leaveLateWriter);
  let text = "";
  // Backpressure after the root's exit (Node resumes every such pipe at the exit): the reader pauses after the first chunk; the second waits in the stream's buffer.
  let busy = true;
  extra.on("data", (chunk) => { text += asText(chunk); if (busy) { extra.pause(); } });
  expect(await child.exited).toBe(0);
  expect({ open: !extra.destroyed, unread: extra.readableLength > 0, heldPipes: child.diagnostics().cleanup?.heldPipes, text })
    .toEqual({ open: true, unread: true, heldPipes: undefined, text: "first" });
  busy = false;
  extra.resume();
  expect(await eventually(() => extra.destroyed && child.diagnostics().cleanup?.heldPipes !== undefined, 5000)).toBe(true);
  expect({ heldPipes: shape(child.diagnostics().cleanup?.heldPipes), text })
    .toEqual({ heldPipes: { waitedMs: "number", pipes: ["extra"], holders: [holder] }, text: "firstsecond" });
});

test.skipIf(!posix)("a `for await` reader still busy past the limit with data unread keeps that data and the pipe's end: no holder, nothing cut", async () => {
  // The second chunk and the end come while the reader is still busy with the first; nothing holds the pipe.
  const child = spawnLineProcess("sh", ["-c", "printf first >&3; sleep 0.3; printf second >&3; exit 0"], { killTree: true, extraPipe: true });
  const extra = child.extraPipe;
  if (extra === undefined) { throw new Error("no extra pipe"); }
  const busy = Promise.withResolvers<void>();
  const read = readAll(extra, busy.promise);
  expect(await child.exited).toBe(0);
  const unread = extra.readableLength > 0;
  busy.resolve();
  expect({ unread, read: await read, closed: extra.destroyed, heldPipes: child.diagnostics().cleanup?.heldPipes })
    .toEqual({ unread: true, read: "firstsecond", closed: true, heldPipes: undefined });
});
