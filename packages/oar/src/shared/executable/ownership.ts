import { execFileSync, type ChildProcess } from "node:child_process";

const ownedChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function killOwnedProcess(child: ChildProcess): void {
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
 * calls process.exit without disposing them. Node does not emit `exit` for
 * an unhandled terminating signal or SIGKILL; hosts own graceful handling.
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
      for (const owned of ownedChildren) { killOwnedProcess(owned); }
    });
  }
}
