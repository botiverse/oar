# Codex vendor directory cleanup

Runtime version check: 2026-11-07.

The Windows Codex job for PR #691 failed while removing the `input-identity`
fixture directory:
[run 42345216739, attempt 1, job 128321374727](https://github.com/botiverse/oar/actions/runs/42345216739/job/128321374727).
Its newly added collaboration-input case passed. The failing identity case
left no process-liveness evidence, and an error from `finally` can replace an
earlier assertion failure. The original logs and artifacts are retained;
the successful single-job retry does not establish the cause or a fix.

## Scope

Only directory cleanup paths executed by `codex-aimock` change. Twelve
vendor files move to `removeFixtureDirectory`:

- Six Codex-only files: runtime requests, tool annotations, collaboration,
  session name, abort processes, and abort processes without process groups.
- The Codex cases in additional directories and structured output.
- The Codex branches in input identity, resumed system prompts, manual
  compaction, and `support/input-interruption.ts`.

Images, image-only and the private Codex HOME already used this helper.
Other backends' branches keep their existing removal calls. Product code,
session disposal, native assertions, case deadlines and CI settings do not
change.

Removal retries are standardized on the helper's existing default:
`maxRetries: 10`, `retryDelay: 300`. There is no per-caller retry option.
Each invocation waits for removal or five seconds; this wait remains part
of the case deadline. The same removal continues after that wait, retaining
its directory identity in any eventual success/failure diagnostic. A removal
failure is recorded without replacing the native test's earlier failure.

## Pending-removal observation

Only Windows `codex-aimock` pending removal starts a process observation.
One PowerShell CIM query requests `Name`, `ProcessId` and `ParentProcessId`.
The observer accepts at most 512 KiB per output stream and records at most
1,024 processes, marking a longer table as truncated. A separate two-second
timer bounds an observer whose callback never returns, including open-pipe
cases. At that limit only the observer is stopped; no sampled PID is signalled.

The cleanup waiter does not await the observer. Captured rows, a timeout or
a fixed failure reason are written to the current trace and job log with
the original directory, purpose, Node test-worker PID (`observerPid`) and timing. Unexpected output
fields are discarded. Command lines, environment variables, executable
paths, query stderr and query error messages are not recorded.

A late result can reach a later trace, so correlate it by directory identity.
A process row is not proof that the process owns a directory lock. An empty,
truncated, failed or timed-out query cannot prove the absence of descendants
or establish a system-indexer/antivirus cause. The query is a single
observation after the five-second wait, not a reconstruction of earlier
process activity. Fast successful or failed removals do not start it.

## Validation and retention

Focused controlled tests cover original-error preservation, the five-second
wait, one-shot nonblocking observation, late directory identity, unavailable
observers, output/row limits and a callback that never returns. With the old
helper, the three observer regressions fail. The test data is synthetic;
it does not validate Windows CIM execution or identify a real lock owner.

Linux validation passed the complete check (3,737 unit tests and 18 mock
behavior cases) and all 78 native Codex 0.167.0 vendor cases using a local
scripted provider. [Selected results and log hashes](vendor-cleanup-validation.json)
retain the earlier failed controls too. The first native run accidentally
used PATH's older Codex 0.162.0: 76 passed and two failed (resumed service tier
and the unknown-model status). Both failures reproduce at the unchanged
base; no assertion was adjusted for them.

Cross-platform results are pending the pull request's ordinary CI. Windows
CIM execution was not tested locally. No extra observation workflow is added.
No natural pending-removal sample with this diagnostic has yet been captured.

Cindy owns the **2026-12-07** [retention review](../acp-ci-failures/closeout.md#diagnostic-retention).
If no target sample arrives, remove the process observer and its dedicated
tests, keeping the cleanup helper and evidence of the unresolved cause.
If failures continue without a target sample, review the probe's placement
rather than treating missing data as a resolution.
