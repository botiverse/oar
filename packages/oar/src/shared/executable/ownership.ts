import { execFileSync, type ChildProcess } from "node:child_process";
import { descendantsOf, killEntries, readProcessTable, type ProcessTable } from "./process-tree.js";

const ownedChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function killOwnedProcess(child: ChildProcess, table: () => ProcessTable): void {
  try {
    if (child.pid !== undefined) {
      if (process.platform === "win32") {
        // A reaped Windows pid can already identify an unrelated process.
        if (child.exitCode !== null || child.signalCode !== null) { return; }
        // An exit listener cannot wait for an asynchronous taskkill. Bound
        // this synchronous cleanup too, and suppress its console output.
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore", timeout: 10_000, windowsHide: true,
        });
      } else {
        // Its descendants outside its group too, found below it only while
        // it runs: a reaped pid may already be someone else's.
        if (child.exitCode === null && child.signalCode === null) {
          killEntries(descendantsOf(table(), child.pid), table());
        }
        process.kill(-child.pid, "SIGKILL");
      }
      return;
    }
  } catch {
    // An empty group or failed tree walk still permits a direct-child try.
  }
  try { child.kill("SIGKILL"); } catch { /* Continue with the other children. */ }
}

/**
 * Own a detached POSIX group or Windows tree until its output pipes close:
 * descendants may hold them after the launcher exits. One synchronous hook
 * covers sessions, probes, updaters, logins and ACP terminals when a host
 * calls process.exit without disposing them; on POSIX it also SIGKILLs the
 * descendants of a child still running that left its group, and their groups
 * (process-tree.ts). Node does not emit `exit` for an unhandled terminating
 * signal or SIGKILL; hosts own graceful handling.
 */
export function trackOwnedProcess(child: ChildProcess): void {
  ownedChildren.add(child);
  const forget = (): void => { ownedChildren.delete(child); };
  child.once("close", forget);
  child.once("error", () => {
    // Other errors (e.g. a failed kill) do not prove the process is gone.
    if (child.pid === undefined) { forget(); }
  });
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      // One read of the process table serves every child.
      let table: ProcessTable | null = null;
      const read = (): ProcessTable => { table ??= readProcessTable(); return table; };
      for (const owned of ownedChildren) { killOwnedProcess(owned, read); }
    });
  }
}
