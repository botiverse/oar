# Windows root identity observation

This is a temporary, manual research branch for task #132. It changes no
product code and authorizes no new descendant cleanup rule. Do not merge
this branch's replacement `ci.yml`. Cindy reviews and dispatches its single
Windows job; it uses read-only repository permissions and no credentials.
The [options comparison](options.md) separates known dependency/handle counts
from the still-unmeasured size and cost of possible native implementations.

Run with Node 24.19.0 on Windows:

```sh
node experiments/windows-root-identity/observe.ts
```

The probe runs normal, immediately failing, and orphan-producing synthetic
roots twice each. Their tools use a private stop file and a 45-second maximum
lifetime. Other processes are only observed. A broken root fixture can be
stopped through its own `ChildProcess` handle, never by a remembered PID.
Queries have an eight-second limit within a 180-second observation budget;
a separate watchdog requests exit at 210 seconds and the job has a five-minute
limit. No process table entry is used as authority to send a signal.

For each root, the synchronous `exit` callback first records both clocks,
then runs the read-only PowerShell helper synchronously. That deliberate block
keeps Node from advancing its event loop while the helper calls `OpenProcess`
and `GetProcessTimes`. Each helper handle is closed before the helper returns.
Normal and orphan cases also query while the root is alive. Another query runs
after the callback and a timer turn. A successful post-callback query could
reflect another handle retaining the old process object; it does not imply
PID reuse. Compare the native creation identity, not only query success.

This tests a source-derived expectation, not the safety of blocking a product
host. It records total helper cost, including PowerShell startup and `Add-Type`,
and must not be adopted as a synchronous production read. Node's public API
does not expose a native process handle or kernel creation time.

The evidence preserves:

- Node and libuv versions, root PID, callback exit code and both clocks.
- Native creation/exit FILETIME strings, query errors and handle close results.
- CIM creation times at full returned precision, parent PIDs and read failures.
- Wall-minus-monotonic offsets before and after every query. FILETIME arithmetic
  uses integers; JavaScript date parsing does not truncate CIM timestamps.
- Candidate membership under the original millisecond lower bound and the
  stricter `spawn Date.now() + 1` bound, both with a strict upper bound taken at
  synchronous `exit`. These are filters only, not ownership claims.
- One deliberately injected CIM failure, separately labeled, and an actual
  invalid-PID `OpenProcess(0)` failure. Neither is an empty successful table.
- Up to 32 additional short-lived processes looking for reuse of an earlier
  root PID. If none reuses it, reuse is **missing**, not verified. Even a numeric
  reuse does not prove the proposed descendant attribution rule.

`synthetic-counterexamples.json` is explicitly synthetic. It shows that a
floored lower bound can admit an earlier child from the same millisecond; a
stricter lower bound can exclude a hypothetical legitimate early child. The
native orphan samples measure whether that exclusion actually occurs here.
It also shows a clock rollback followed by restoration between observations:
every sampled wall-minus-monotonic offset agrees, yet a later child can fall
inside an earlier root's time interval. Discrete samples cannot prove that no
clock change happened between them. The probe never changes the machine clock
or forces system-wide PID reuse.
Another synthetic example retains a new root's handle while an old owner's
child still carries the reused parent PID. A rollback before the new root's
creation defeats timestamp ordering even though future PID reuse is prevented.

`events.jsonl` is printed as well as saved. Per-case results are written as
soon as available; `report.json` combines completed cases. Missing native
identity at the exit boundary makes the step fail. Missing PID reuse remains
an explicit research gap. No Windows result exists until the manual run.
The native exit code and completed exit timestamp must also match the observed
root exit, normal cases must match the identity read while alive, and the
orphan's recorded tool must appear in a successful CIM read.
Unexpected fixture exit or input errors also fail the step. The injected CIM
failure and the invalid PID's native error must actually be observed, not merely
requested.

## Source basis and limits

Microsoft documents that [a process object's handles keep its PID allocated](https://devblogs.microsoft.com/oldnewthing/20110107-00/?p=11803),
and that [termination does not destroy an object until its last handle closes](https://learn.microsoft.com/en-us/windows/win32/procthread/terminating-a-process).
[`GetProcessTimes`](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)
returns creation and exit times from an opened process handle;
[`Win32_Process`](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process)
provides `CreationDate` and `ParentProcessId`. The helper requests only
`PROCESS_QUERY_LIMITED_INFORMATION` and closes every successfully opened handle.

For the pinned Node version, JavaScript
[calls `_handle.close()` before emitting `exit`](https://github.com/nodejs/node/blob/v24.19.0/lib/internal/child_process.js#L256-L288),
while libuv [queues process handle closure for its endgame](https://github.com/nodejs/node/blob/v24.19.0/deps/uv/src/win/process.c#L771-L835).
The expectation that the original handle is still retained inside a synchronous
listener is an inference from this implementation. It does not extend across
an `await`, a Promise continuation, or pipe `close`, and is not a stable public
Node contract. The native readings may corroborate it but cannot identify
which other OS component holds a handle. Any production dependency requires a
separate design review and must preserve fresh descendant identity checks.
The nested synchronous helper uses
[a separate libuv loop](https://github.com/nodejs/node/blob/v24.19.0/src/spawn_sync.cc#L437-L510),
so it does not intentionally run the original root's queued endgame.
