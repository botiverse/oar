import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { signalEntries, type ProcessEntry } from "../packages/oar/src/shared/executable/process-tree.js";
import { gone, reportShellChild, reportedProcess, signalFixture, type ProcessIdentity } from "./fixtures/process-tree.js";

// What OAR keeps of the processes left holding an exited root's pipes once it
// closed its end (pipe-close.ts, ownership.ts), and how an EPERM counts.
// The bounded wait itself: process-held-pipes.test.ts.
const posix = process.platform !== "win32";
const started: ProcessIdentity[] = [];
const scratch: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const pid of started.splice(0)) { signalFixture(pid); }
  for (const directory of scratch.splice(0)) { rmSync(directory, { recursive: true, force: true }); }
});

test("an EPERM from a process OAR may not signal is foreign, not a failed cleanup", () => {
  const entry: ProcessEntry = { pid: 424_242, ppid: 1, pgid: 424_242, start: "1" };
  const table = new Map<number, ProcessEntry>([[process.pid, { pid: process.pid, ppid: 1, pgid: process.pid, start: "0" }], [entry.pid, entry]]);
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); });
  expect(signalEntries([entry], table)).toEqual({ hostIdentified: true, signalled: 0, failed: 0, foreign: 1, codes: [] });
});

const scratchDir = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), "oar-test-held-pipes-"));
  scratch.push(directory);
  return directory;
};

/** The identities the host saved while it still owned both children. */
function recorded(file: string) {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof value !== "object" || value === null || !("kept" in value) || !("reused" in value) || !("holders" in value)) {
    throw new Error("Missing holder identities");
  }
  const kept = reportedProcess(value.kept), reused = reportedProcess(value.reused);
  started.push(kept, reused);
  return { kept, reused, holders: value.holders };
}

const processModule = new URL("../packages/oar/src/shared/executable/process.ts", import.meta.url).href;

// Review B1: after OAR closes the pipes, the host-exit hook ends what was left
// only while it is the same process; once that is gone, the root's pid (and
// group id) can name an unrelated process, which must never be signalled.
test.skipIf(!posix)("host exit after OAR closed the pipes ends a holder still there, but not a process group whose pid was reused", async () => {
  const out = path.join(scratchDir(), "pids");
  const source = `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    import { spawnLineProcess } from ${JSON.stringify(processModule)};
    import { captureProcess, reportedProcess, signalFixture } from ${JSON.stringify(new URL("fixtures/process-tree.ts", import.meta.url).href)};
    const leave = async () => {
      const child = spawnLineProcess("sh", ["-c", ${JSON.stringify(`sleep 60 & ${reportShellChild}; exit 0`)}], { killTree: true });
      const holder = await new Promise((resolve) => { child.onLine((line) => { resolve(reportedProcess(JSON.parse(line))); }); });
      await child.exited;
      return { child, holder, holders: child.diagnostics().cleanup?.heldPipes?.holders };
    };
    const [kept, ended] = await Promise.all([leave(), leave()]);
    // The second holder exits; its root's pid and group id are free, and an
    // unrelated process (a group of its own) now has that number.
    signalFixture(ended.holder);
    const reused = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const replacement = captureProcess(reused.pid);
    reused.unref();
    // Stand-in for that reuse (a real one cannot be forced): a signal to the old number reaches the new process.
    const root = ended.child.pid;
    const realKill = process.kill.bind(process);
    process.kill = (pid, signal) => realKill(Math.abs(pid) === root ? Math.sign(pid) * reused.pid : pid, signal);
    writeFileSync(${JSON.stringify(out)}, JSON.stringify({ kept: kept.holder, reused: replacement, holders: kept.holders }));
    process.exit(23);
  `;
  const host = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { encoding: "utf8", timeout: 20_000 });
  const { kept, reused, holders } = recorded(out);
  expect({ status: host.status, stderr: host.stderr, holders }).toEqual({ status: 23, stderr: "", holders: [kept.pid] });
  expect({ keptGone: await gone(kept), reusedGone: await gone(reused, 200) }).toEqual({ keptGone: true, reusedGone: false });
});
