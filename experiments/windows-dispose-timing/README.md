# Windows dispose timing

Runtime version check: 2026-10-31

This temporary manual probe compares a fresh Windows runner with a separate
runner that first performs the existing test-only CIM preparation. Both run
Claude 2.1.316 against the same scripted provider and unchanged behavior suite
three times. A failing case stays a failure. The normal Vitest global setup
is deliberately absent from this experiment's config.

Vitest wrappers call the actual process-table, cleanup and shutdown functions.
They retain request entry and completion, query-command entry and completion,
EOF dispatch, taskkill creation/exit/close, native root exit/close, and cleanup
phase boundaries. No product sources, delays, deadlines or outcomes are changed.
The query adds three side-file stage observations around the actual CIM call
and one after serialization. These use .NET AppendAllText rather than loading
another PowerShell module. They buffer CIM rows before applying the unchanged
projection; that instrumentation overhead and the extra log writes are a
limitation when comparing precise durations with the uninstrumented CI sample.

`timing.jsonl` contains metadata only, while `powershell-stages.tsv` separates
PowerShell command entry from CIM query time. A killed query can leave partial
stages. The ordinary session trace is retained for each round. Unobserved stages
remain missing, not zero. Read-return time minus the product's query duration
measures caller waiting plus wrapper overhead; the shared serial query timeline
identifies which physical reads preceded that caller.

```sh
OAR_WINDOWS_TIMING_PREPARED=false pnpm vitest run --config experiments/windows-dispose-timing/vitest.config.ts
OAR_WINDOWS_TIMING_PREPARED=true pnpm vitest run --config experiments/windows-dispose-timing/vitest.config.ts
```

Run these on separate fresh Windows runners for the first-use comparison.
Later rounds within a job share that runner's initialization. A local smoke
run can select the mock backend with `OAR_TIMING_BACKEND=mock`; it does not
produce native Windows evidence. The temporary workflow on the investigation
branch is manual-only, read-only, account-free, and must not be merged.

## Observation, 2026-10-31

The baseline run [41193731535](https://github.com/botiverse/oar/actions/runs/41193731535)
used probe commit `62bfde73ff0ee441353293b6bdd50e01c6e3c191` and unchanged
product commit `3e47590f5063fc763774eb42a4e898503c7d3003`. Each runner executed
three full Claude 2.1.316 behavior rounds; all passed, including the unchanged
15-second disposal case. These are timings of all 51 stops per runner, not
51 repetitions of that one case. The two runners have different startup
histories, so this is an observation rather than a paired causal benchmark.

| Baseline group | Read requests / physical queries | Median stop | Longest stop | Longest caller waiting plus wrapper overhead |
| --- | --- | --- | --- | --- |
| No explicit preparation | 56 / 27 | 1.030 s | 11.692 s | 5.053 s |
| Existing test preparation | 56 / 31 | 1.220 s | 8.383 s | 2.880 s |

There were no overlapping physical query intervals. Multiple callers share
one query, so the queue is not caused by starting one PowerShell for every
caller. Requests arriving after a query starts require a later fresh batch;
this necessary freshness rule explains additional waiting. Completed results
must not be reused to make those waits look shorter.

The unprepared runner's longest stop (round 1, PID 8704) spent 11.419 seconds
in capture: query durations 5.099 seconds (timeout) and 1.309 seconds
(success), plus 5.011 seconds waiting and wrapper overhead. EOF to root exit
was 0.270 seconds; final cleanup took 0.0002 seconds and required no query.
The first physical query reached its CIM start marker but no end marker.
The next physical query also timed out; its CIM end marker was present but
its serialization-complete marker was absent. The artifacts therefore do
not attribute every slow millisecond exclusively to CIM itself.

The prepared runner's two longest stops show a second cost. Round 3 PID 6784
spent 2.605 seconds capturing, 0.487 seconds from EOF to root exit, and
5.291 seconds in post-exit revalidation. Round 2 PID 8984 spent 2.223,
0.548 and 5.428 seconds respectively. Revalidation includes a fresh-query
wait, not just the physical query. Across both groups taskkill dispatch to
root exit never exceeded 0.548 seconds. The explicit preparation itself took
4.316 seconds, with 0.854 seconds inside CIM; preparation is outside the
behavior cases' timing windows.

### The original failure has an evidence boundary

[PR 576's Windows Claude job](https://github.com/botiverse/oar/actions/runs/41192512304/job/124511983930)
recorded 16.439 seconds from dispose to exited for session
`d3eee200-7972-4a0d-bad7-503428e758ed`. Both before-EOF queries timed out
(5.012 and 5.009 seconds). Their 10.021-second sum leaves 6.418 seconds
without stage timestamps. The recorded cleanup has no successful capture
or remembered descendants, so that remainder cannot be a post-exit table
read. Windows Claude requests EOF and taskkill immediately after capture;
it does not first wait the POSIX ten-second grace.

The original 6.418 seconds cannot be reconstructed by phase from that trace.
The new baseline demonstrates about five seconds of caller queueing, with
subsecond native termination, but does not prove the exact distribution in
the earlier failing job. Post-exit revalidation is a separate cost established
by the new prepared samples. No assertion or case deadline was changed.

### Resulting product policy

The first actual Windows tree-owning line-process spawn starts one
asynchronous preparation through the regular serial reader. Only diagnostic
metadata is retained, never identities. Before-EOF capture has a five-second
total budget including queueing; timeout is not retried, and another failure
may retry once with the remainder. Force and post-exit observations each have
their own five-second total budget. Expiry reports unverified cleanup and
never signals from a late snapshot; force still stops the owned root.
Preparation alone does not keep an otherwise finished host alive. Its timer,
query child and pipe are unreferenced; a foreground caller joining before
query start keeps the combined batch referenced. Host-exit ownership still
stops a running query.

This bounds OAR's observation waits, not entire disposal: taskkill and native
exit have no hard deadline. Native EOF hooks and the existing escalation
grace are unchanged. This includes short tree-owning model, inventory and
account probes, or a command shell that starts before reporting a missing
target. `runExecutable` help/version commands do not start preparation;
the synchronous host-exit hook neither waits for it nor consumes its result.
Preparation metadata is sampled only in a process's completed cleanup
diagnostic, rather than appearing in unrelated startup errors. The behavior
entry does not add test-only preparation, so its unchanged 15-second disposal
assertion exercises the product's cold path. The baseline run
above predates this policy; changed Windows behavior must be validated by the
implementation's CI, and is not claimed as measured here.

The accepted tradeoff is bounded observation waiting with explicit uncertainty.
Under this policy the cold PID 8704 capture would expire near five seconds
as unverified, rather than succeeding through a retry after 11.4 seconds.
Native shutdown and any required revalidation still follow; five seconds
is not a promise for the complete stop.

### Rebuild the evidence

The [manifest](manifest.json) identifies both downloaded archives and the
SHA-256 of selected inputs. Stamp verified archive hashes during download.
[Selected data](selected.json) retains every stop, caller read and physical
query interval, including missing native stage markers and cleanup failures.
Durations use the host's monotonic clock; PowerShell side-file markers use
that runner's wall clock. Caller waiting is elapsed read time minus the
product's reported query duration, including wrapper overhead.

```sh
stamp run download 41193731535 --repo botiverse/oar --dir /tmp/windows-dispose
python3 experiments/windows-dispose-timing/select.py /tmp/windows-dispose > /tmp/selected.json
cmp /tmp/selected.json experiments/windows-dispose-timing/selected.json
```

The temporary workflow is not included in this change. The probe's source
remains reusable; rerunning it against a newer product commit measures that
commit, not the historical baseline.
