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
