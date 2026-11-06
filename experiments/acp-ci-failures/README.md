# Native CI failure follow-up: 2026-11-06

The failures separate into three boundaries: CodeBuddy installation, the
Antigravity MCP mismatch, and all 18 failed Windows Grok/OpenCode jobs from
the [November 6 observation window](../runtime-version-checks/2026-11-06.md).
No cause is established for any of these intermittent failures. Existing
assertions, native deadlines, test limits and concurrency remain unchanged.

The [first Windows follow-up](windows-followup.md) adds two complete provider
timelines, Grok bootstrap phases, recording-cost comparisons and two more
ordinary CodeBuddy install samples. It also explains why native OpenCode
logs are now retained before fixture cleanup.

## CodeBuddy: one successful install nearly reaches the test limit

Three earlier Windows checks (#668, #672 and #674) stopped the first npm
installation at 180 seconds without retaining npm's own logs. Their cause
remains unknown. [PR #676](https://github.com/botiverse/oar/pull/676) retains
phase records and bounded npm debug/timing logs before deleting the isolated
HOME. Its first Windows check succeeded, but the install took 169.340 seconds,
leaving only 10.660 seconds before the test's limit.

In [job 128087646583](https://github.com/botiverse/oar/actions/runs/42274624041/job/128087646583),
CodeBuddy 2.181.0 installed with npm 11.19.1. The selected
[sample](codebuddy-windows-selected.json) retains source hashes, artifact
digest and timings without local paths. npm measured `reify:unpack` at
157.155 seconds and `reify:build` at 16 ms. Its cache-miss tarball log entries
for CodeBuddy and `openai` lasted 157.134 and 149.778 seconds respectively.
These intervals can overlap and include stream consumption and unpacking;
they are not isolated network-transfer measurements. npm logs were saved
before fixture cleanup began.

This one success makes a slow installation plausible, but does not establish
why the three previous attempts timed out. Verbose logging itself also has
overhead. Collect the next five to ten samples from ordinary PR Windows
checks, including failures; do not launch extra workflows for this study.
Compare total install time and npm phase durations. On another timeout,
inspect whether log activity continued or stopped at one operation before
proposing a change.

The 180-second install limit, 240-second child limit and five-minute CI step
remain unchanged. Any proposal for more test headroom must account for all
three budgets and the observed distribution. A stalled operation calls for
further diagnosis, not a longer wait. The product's default `install()` limit
is already 600 seconds; the 180-second value is this smoke test's explicit
override, so this evidence does not call for a product timeout change.

Re-select the measured phases and npm timers from an unpacked sample without
running npm or a model:

```sh
python3 experiments/acp-ci-failures/codebuddy-sample.py /path/to/sample selected.json
```

The committed selection additionally identifies the GitHub run, job and
artifact. Keep raw logs local; they include temporary paths.

## Antigravity: the scripted provider's decision was not archived

In [main run 42267287565, attempt 1](https://github.com/botiverse/oar/actions/runs/42267287565/job/128062392077),
macOS Antigravity CLI 1.5.0 completed the MCP name-clash turn after calling
only `mcp_echo_echo` with `call_clash-own`. Its next text was the fixture's
literal `echoed`, and the turn completed 67 ms after the prompt. The expected
`call_mcp_tool` for `userecho` never appeared in the session trace. The test
correctly failed on the missing `clash-user` result.

The artifact contains session records, but no raw provider requests or
matcher journal. Consequently it cannot tell whether the provider selected
a premature terminal fixture, a call was changed in transit, or the native
runtime omitted a requested call. A completed turn did not trigger the old
failure-only journal dump. The same test passed in PR #674 and on the main
job's unchanged retry; these passes do not explain the failure.

Ten fresh, sequential Linux controls using the same CLI 1.5.0 and fixture
all executed both calls in order. Each made four provider requests: a title
request with no tools, the initial agent request, then the two tool-result
requests. In these controls the title request also matched the initial
call fixture; the agent's two tool results still selected the second call
and final `echoed` correctly. This is an observation, not evidence that
request order caused the macOS failure.

[Selected macOS events and all ten controls](antigravity-selected.json)
omit native session IDs, paths and credential markers. Raw-file hashes
identify the retained originals. The
[reproduction entry](antigravity-name-clash.ts) defaults to one fresh run:

```sh
OAR_TEST=antigravity-aimock OAR_ANTIGRAVITY_BIN=/path/to/agy-1.5.0 \
  OAR_TRIAL_RUN_DIR=/path/to/evidence \
  pnpm tsx experiments/acp-ci-failures/antigravity-name-clash.ts 1
```

It uses the unchanged two-call fixture and local MCP servers, with no
account or real model. An optional round count is bounded at ten. Raw
requests, matcher results and session records stay in the chosen local
artifact directory; review/redact them before publishing.

## Windows: 26 main runs, two different failure boundaries

The fixed window is November 5 20:00 through November 6 17:03:29 UTC.
Kimi passed all 26 jobs; Grok and OpenCode each passed 17 and failed nine.
Every failed job's raw log and native artifact was downloaded; artifact
SHA-256 digests were verified. The [manifest](manifest.json) links the jobs
and identifies logs/artifacts; [selected results](windows-selected.json)
retain every failed case, Grok startup control and OpenCode MCP timeline.

### Grok 1.0.70

All nine failed jobs reach ACP `initialize`'s existing 15-second limit.
Four fail the first two shared cases, so their vendor phase does not run.
The remaining five fail nine vendor cases across MCP, model/error handling
and manual compaction, also at initialization. They are not nine separate
functional regressions. Two shared-case failures additionally report
unverified descendant cleanup after their separate Windows process-table
read timed out; that evidence is retained in the selected case text.

Each failed job also ran the existing five-way startup comparison after its
tests, with a fresh Grok HOME for each launch:

| Launch path | Initialized / total | Successful duration range |
|---|---:|---:|
| OAR-resolved entry, npm wrapper, explicit Node launcher | 26 / 27 | 5.190 to 14.078 s |
| Direct native executable, ordinary or overlapped pipes | 18 / 18 | 1.438 to 2.153 s |

The explicit Node launcher in
[job 127805131378](https://github.com/botiverse/oar/actions/runs/42191724685/job/127805131378)
itself timed out at 15,005 ms with no stdout or stderr. Thus the startup
failure can also occur without an OAR session adapter. This does not
establish what consumed the time, and the later direct-native successes
are sequential controls, not a simultaneous comparison under equal load.

Inspection of the installed 1.0.70 npm bootstrap ([source identity](grok-source.json)) explains a relevant path
difference: a fresh `GROK_HOME` has no canonical binary, so the launcher
extracts a versioned binary from the platform package and, on Windows,
copies it to the canonical executable before spawning it. Direct-native
controls bypass this materialization. The failed artifact does not record
when extraction, copying or native execution began. Those phases are the
next bounded measurement; do not increase the native wait, prewarm the
suite or replace its executable based on this correlation alone.

### OpenCode 1.19.5

All nine failures are in vendor tests, after shared behavior passed. The
14 failed cases are:

| Case | Failures | Existing case limit |
|---|---:|---:|
| Same-name MCP servers | 3 | 180 s |
| System prompt plus session MCP servers | 2 | 180 s |
| Scripted rate-limit words | 2 | 240 s |
| Host-served MCP tool | 5 | 120 s |
| MCP catalog change | 2 | 120 s |

These are not all cleanup after a successful turn. Four failed host-tool
traces have no tool call or turn end; another has its first call after
115.104 seconds but no turn end. Both failed system-prompt cases also lack
a tool call and turn end in their artifact.

Some timed-out turns do finish late. In jobs
[128016937122](https://github.com/botiverse/oar/actions/runs/42254208340/job/128016937122),
[127957195864](https://github.com/botiverse/oar/actions/runs/42237026967/job/127957195864)
and [127743111470](https://github.com/botiverse/oar/actions/runs/42172429723/job/127743111470),
the name-clash first call arrived 288.546, 192.037 and 177.098 seconds after
the accepted prompt; completion arrived at 291.911, 193.684 and 180.400
seconds. Case limits include setup before the prompt too. The original
failures remain failures even when a late event later reaches the trace.

Across these nine jobs, the ordinary initial stdio/HTTP turn's first tool
arrived after 66.504 to 117.148 seconds, while the resumed turn's first tool
arrived after 0.893 to 1.521 seconds. Existing ten-second progress samples can
show only one provider request while a host-tool case waits. That count
does not identify a title request versus an agent request, or show which
response was returned. Scripted error messages in stderr do not fill this
gap. Initialization, model dispatch, response streaming and MCP execution
must be distinguished before choosing a fix.

## Incremental fixture evidence

The synthetic ACP provider now writes one file per fixture under
`OAR_TRIAL_RUN_DIR/acp-provider/`, outside its disposable HOME. Existing
Antigravity and Windows ACP artifact uploads already include this directory.
The file begins when the provider fixture starts, then records:

- Native request bodies and the forwarded body where a request rewrite is
  configured, with a local request number.
- HTTP response status, response chunks in base64, end and close markers.
  Chunks remain streamed to the runtime as they arrive; they are not held
  until the turn or test completes.
- Newly available aimock journal entries, without headers, including the
  normalized request and matched fixture index. Journal indices are
  separate from proxy request numbers because requests may overlap.

No authentication headers, URL query strings or environment dump are
written. These are local scripted-provider payloads, not real-account
telemetry. Evidence is limited to 1 MiB per entry and 8 MiB per fixture;
oversized entries keep an explicitly marked 32 Ki-character tail, and a
file limit writes `file_truncated` then stops recording. Truncated evidence
cannot establish that a missing call never existed. A write failure warns
and disables that file without replacing the original provider result.

This covers an apparently successful but wrong turn and a stream that never
finishes, as well as ordinary errors. It changes no fixture matcher,
normalization, provider result, runtime choice or timeout. For the next
failure, compare the incoming request, matched fixture, outgoing response
and native tool events before changing the model script or adapter.

Unit controls verify incremental/overlapping streams, a partial upstream
response, request/response rewrites, a failing observer, retention before
HOME cleanup, and explicit size limits. Full local checks passed (3,651 unit
tests and 18 mock behavior cases). With this instrumentation, Linux native
vendor suites passed for Antigravity 1.5.0 (12 cases), Grok 1.0.70 (21),
OpenCode 1.19.5 (10) and Kimi 2.4.1 (12); all four behavior backends also
passed. Windows/macOS require new CI evidence. Passing controls do not close
the original failures.

## Recompute the selection

Download each raw job log as `<job>.log`, and unpack its artifact in the
manifest's `directory` beneath one local directory. Copy `manifest.json`
there, then run:

```sh
python3 experiments/acp-ci-failures/summarize.py /path/to/downloads selected.json
```

The script verifies log hashes and selects recorded facts without invoking
runtimes or models. The selected timelines measure from accepted prompts,
not process launch or the beginning of the Vitest case. The older
[October 29 baseline](../acp-ci-2026-10-29.md) retains the first failures and
the reason Windows remains an observation workflow outside the PR gate.
