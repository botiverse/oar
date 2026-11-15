# ACP fixture process identity: 2026-11-15

The sharing tests must distinguish successive fixture processes even when
the operating system reuses a PID. Their trace now carries a random instance
ID generated once at process startup, alongside the real PID and method.
Only the synthetic fixture and its tests change; production sharing
admission and process cleanup are unchanged.

## Observed failure and evidence limit

The [main CI run after PR #803](https://github.com/botiverse/oar/actions/runs/43718466982)
at `8d9cee43df52f577677879fce2c2186642ba5a4c` finished with 40 successful jobs
and one failed Windows check. Its
[failed job](https://github.com/botiverse/oar/actions/runs/43718466982/job/132825020958)
reported one initialize-only process group instead of two in
`tests/opencode/shared-session.test.ts`, for stale native version `2.2.4`.
The preceding placement, launch-count, refusal and process-closed assertions
passed. This test and its fixture were not changed by PR #803.

The test grouped trace rows by PID across process lifetimes. Windows permits
PID reuse after the old process object is freed, as documented for
[`PROCESS_INFORMATION`](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-process_information).
The fixture writes each trace row synchronously before answering the RPC.
However, the original trace was in a temporary directory removed during
test cleanup and was not uploaded. The job log alone does not establish
whether PID reuse caused this particular failure. Its complete log is
retained locally; no reconstruction is presented as that missing trace.

## Controlled counterexample

The new [regression sample](../tests/acp/acp-fixture-trace.test.ts) uses four
process instances and three PIDs:

| Instance | PID | Methods |
| --- | --- | --- |
| Original, subsequently exited | 101 | initialize, session/new, session/close |
| Refused automatic shared launch | 101 | initialize |
| Isolated fallback | 202 | initialize, session/new |
| Refused explicit shared launch | 303 | initialize |

Grouping this newly constructed sample by PID joins the first two rows.
Only PID 303 then appears to have initialized without opening a session,
reproducing the incorrect count of one. Grouping by instance keeps both
refused launches separate and retains every method. This counterexample
failed with the old grouping code before the fix and passes afterward;
it does not simulate an operating system assigning real PIDs.

## Fix and validation

The [shared fixture](../tests/fixtures/fake-acp-shared.mjs) generates its
instance ID once, not per request. The
[trace reader](../tests/fixtures/acp-trace.ts) requires that ID rather than
falling back to a PID. Both OpenCode and Grok use it, assert four distinct
instances and still require exactly two that received only `initialize`.
The count assertions include the complete synthetic trace in their failure
message, retaining the IDs, real PIDs and methods in the CI log. No request
parameters or credentials are logged.

The original placement refusals, launch counts, process-closed checks and
OpenCode recovery to an admitted version remain in place. Their time limits
are unchanged. The four targeted test files passed on Linux: 54 tests and
one existing platform skip. The complete `CI=1 pnpm run check` gate also
passed: 4,371 unit tests and 18 mock behavior checks. Windows validation
remains part of the normal pull-request CI gate.
