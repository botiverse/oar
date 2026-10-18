/**
 * End the process once a finished command has had `graceMs` to flush its
 * output, even when a runtime left a handle behind in it. @cursor/sdk 1.0.35
 * to 1.0.37 arm a 24 hour timer for each shell call they move to the
 * background and never clear it, so after such a turn the process would
 * outlive its run by a day; 1.0.38 clears it, and the exit stays as a
 * backstop. The timer is unref'd: a process with nothing left exits on its
 * own first, with its own exit code.
 */
export function exitWhenFinished(graceMs = 1000): void {
  setTimeout(() => {
    process.exit();
  }, graceMs).unref();
}
