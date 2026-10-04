/**
 * End the process once a finished command has had `graceMs` to flush its
 * output, even when a runtime left a handle behind in it. @cursor/sdk 1.0.35
 * arms a 24 hour timer for each shell call it moves to the background and
 * never clears it, so after such a turn the process would outlive its run by
 * a day. The timer is unref'd: a process with nothing left exits on its own
 * first, with its own exit code.
 */
export function exitWhenFinished(graceMs = 1000): void {
  setTimeout(() => {
    process.exit();
  }, graceMs).unref();
}
