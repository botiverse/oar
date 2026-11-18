# Process-tree kill across a user boundary

**Question.** A host runs a runtime as another OS user: `installation.command`
is a wrapper that runs `sudo -n -u <worker> -- <runtime> "$@"`. OAR's direct
child is then sudo (setuid root; the host may signal it), and everything
below it is the worker's (`EPERM` for the host). What do OAR's stop, its
descendant signals and its wait for the child's output pipes do?

**Setup** (2026-11-18, Ubuntu 22.04, sudo 1.9.9, kernel 6.12). A worker user
`oarx-test`, passwordless `sudo -n -u oarx-test`. The stand-in runtime is
`sh -c 'sleep 900 & exec sleep 901'`: a background process that keeps the
runtime's stdout and stderr, as a tool or a daemon would. `OAR_KILL_GRACE_MS`
is 1000 to keep the run short. [`repro.ts`](repro.ts), from the repository
root, as the host user; run it on a checkout without the change for the
"before" column:

```sh
pnpm tsx experiments/cross-user-kill/repro.ts <worker>
```

CI cannot run it: it needs sudo and a second user. The unit tests
([`tests/process-held-pipes.test.ts`](../../tests/process-held-pipes.test.ts))
cover the same paths without sudo: a real background holder, and `EPERM`
injected the way sudo produces it.

**Result, before** (origin/main at 4015fb1):

```
== 1. a session process through the wrapper, stopped with kill()
   root (OAR's child) 15478: sudo; the worker's: 15479:sleep(pgid 15478, ppid 15478), 15480:sleep(pgid 15478, ppid 15479)
   exited: null after 43 ms; cleanup {"status":"observed"}
   3 s later: OAR's stdout closed: false; the worker's left: 15480:sleep(pgid 15478, ppid 1)

== 2. a signal to the worker's process, as the turn cleanup sends it (signalEntries)
   signalEntries(the worker's 15490, SIGTERM) -> {"hostIdentified":true,"signalled":0,"failed":1,"codes":["EPERM"]}

== 3. a one-shot command through the wrapper that times out (runExecutable, timeoutMs 1500)
   after 20002 ms: still pending after 20 s
```

**Result, after** (the first version of the change, f98e4dd on 751fc53):

```
== 1. a session process through the wrapper, stopped with kill()
   root (OAR's child) 15629: sudo; the worker's: 15630:sleep(pgid 15629, ppid 15629), 15631:sleep(pgid 15629, ppid 15630)
   exited: null after 2055 ms; cleanup {"status":"observed","heldPipes":{"waitedMs":2014,"holders":[15631]}}
   3 s later: OAR's stdout closed: true; the worker's left: 15631:sleep(pgid 15629, ppid 1)

== 2. a signal to the worker's process, as the turn cleanup sends it (signalEntries)
   signalEntries(the worker's 15651, SIGTERM) -> {"hostIdentified":true,"signalled":0,"failed":0,"foreign":1,"codes":[]}

== 3. a one-shot command through the wrapper that times out (runExecutable, timeoutMs 1500)
   after 4526 ms: {"ok":false,"timeoutMs":1500,"heldPipes":{"waitedMs":3012,"holders":[15662]}}
```

**Conclusion.** The SIGTERM still reaches the direct child: sudo relays it to
its command (`sleep 901`) and exits. The background `sleep 900` is the
worker's and survives either way; only the worker (here
`sudo -u oarx-test kill -KILL -1`) can end it. Before, OAR counted its `EPERM`
as a failed signal; it never closed its end of pipes the orphan still held, so
a session's pipes stayed open (and kept the host's event loop alive) for the
orphan's life, and a timed-out one-shot command never returned. After, the
`EPERM` is `foreign`, not a failure; 2 s after the exit (the kill grace plus
2 s for a stopped command) OAR closes its end and names the holder in the
cleanup report (`exited.reason` for a session). In both runs
`sudo -u oarx-test kill -KILL -1` afterwards left none of the worker's
processes.

**Not rerun after review.** The revised change (on c0677657) was checked
same-user only, by `tests/process-held-pipes.test.ts`. What it changes in
the "after" output above, by the code, not by a new sudo run: `heldPipes`
also lists the closed pipes (`"pipes":["stdout","stderr"]`); `holders` are
the processes left in the root's process group (15631 is in group 15629, so
it is still named); case 3's wait starts at the SIGKILL, not at the stop, and
its result fails with `OUTPUT_INCOMPLETE`; a codex abort cleanup in this
situation reports `foreign`.
