# Runtime process resources and shared-session isolation: 2026-10-28

This is a Linux measurement and native-protocol investigation, not a change to
OAR's process ownership. All model responses came from local scripted providers;
no account quota was used. The results support investigating process reuse, but
a successful turn cancellation is not evidence that the turn's tools stopped.

At ten sessions, Codex's process-forest RSS after a simple turn was 1,974 MiB
with one app-server per session and 218 MiB with ten threads on one app-server.
Kimi, Grok, both OpenCode lines and Antigravity also accepted concurrent native
sessions on one ACP connection with lower RSS than separate OAR sessions. This
is not a throughput benchmark or a recommendation to change the default yet.

The important lifecycle findings are:

- Codex deliberately retains unified-exec commands across interrupted turns.
  This happened in both shared and existing isolated OAR sessions. Its native
  per-thread background-terminal API can terminate a command, and archive
  stopped all commands in the measured target thread without stopping peers.
  Archive changes persisted state: unarchive is required before resume.
- Grok's native cancel and close left host-created terminals running. The
  reverse terminal requests carry session identity, so a host can dispose
  only that session's terminal host. That control stopped the tools and left
  the other session usable.
- Kimi, both OpenCode versions and Antigravity stopped the measured command
  tree within the two-second cancellation observation. Their peers stayed
  active and could run another prompt after the target session closed.

The [compact observations](runtime-resources-2026-10-28.json) retain every
resource cohort and interruption repetition, without credentials, machine-local
paths or native conversation IDs. The scripts below write detailed wire and
process evidence locally, including unsuccessful attempts.

## Method and limits

Measured on Linux 6.12.93 x64, Intel Xeon Platinum 8259CL, 16 logical CPUs,
67,419,242,496 bytes of RAM. The machine also ran unrelated work. No macOS or
Windows resource measurements were made.

`support/linux-resources.ts` sums RSS over each observed child root, its process
group and descendants. It tracks process start ticks to avoid confusing PID
reuse with a survivor. RSS includes shared pages once per process; it is not
PSS, unique physical memory, a heap profile or a memory reservation. The npm
Codex launcher remains in the measured forest, about 50 MiB per isolated
instance. Antigravity's one shared ACP connection had eleven OS processes at
ten sessions, so “shared” does not mean literally one OS process.

Each fresh cohort waits two seconds, samples CPU over approximately five
seconds, runs one short scripted turn per session, then repeats the wait and
sample. RSS and descriptor counts are the final snapshots of each window.
CPU is a percentage of one core, so 100% means one busy core, not the whole
machine. A process that exits during a window makes CPU a lower bound; that
flag is retained in JSON. The observer reads procfs counters, never argv,
environment variables or descriptor targets. A denied descriptor read produces
an explicit unknown count and a recorded error, not zero.

There is one successful resource cohort per runtime, mode and size. The
isolated cohorts open sessions and send prompts serially; the shared ACP
cohorts open and prompt concurrently. The small replies exercise real startup
and protocol machinery, not realistic model latency or long-context work.
Two seconds is not proof that startup has settled: OpenCode v1 still showed
substantial CPU activity in its measured windows. Later lower RSS may reflect
allocator or collection timing, but this probe does not establish the cause.

The resource cohorts have no MCP servers. Separate two-session probes below
check cwd, MCP identity, cancellation and continued peer use. Each probe uses
private temporary configuration and a child environment with host credentials
removed. Cleanup observations found no surviving observed processes in the
successful cohorts.

## Resource observations

Values below are MiB of process-forest RSS, shown as idle / after one turn.

| Runtime and version | Mode | 1 session | 5 sessions | 10 sessions |
| --- | --- | ---: | ---: | ---: |
| Codex 0.165.0 | isolated | 177.8 / 197.9 | 886.0 / 985.9 | 1782.7 / 1974.4 |
| Codex 0.165.0 | shared | not measured | not measured | 191.5 / 218.0 |
| Claude 2.1.312 | isolated | 184.0 / 195.4 | 900.6 / 966.0 | 1792.3 / 1919.3 |
| Kimi 2.3.3 | isolated | 447.6 / 456.3 | 2223.3 / 1695.4 | 3633.7 / 3369.9 |
| Kimi 2.3.3 | shared | 448.2 / 457.1 | 450.2 / 373.4 | 470.7 / 395.7 |
| Qwen 0.26.2 | isolated | 457.3 / 486.5 | 2234.1 / 2429.0 | 4498.0 / 4852.4 |
| Qoder 1.1.80 | isolated | 717.4 / 370.8 | 2266.0 / 1875.0 | 4155.0 / 3777.5 |
| Grok 1.0.70 | isolated | 114.0 / 123.1 | 569.8 / 615.5 | 1138.6 / 1231.3 |
| Grok 1.0.70 | shared | 116.1 / 125.6 | 128.2 / 141.9 | 138.9 / 158.8 |
| OpenCode 1.19.5 | isolated | 520.0 / 767.8 | 2006.2 / 2595.9 | 3158.8 / 4461.8 |
| OpenCode 1.19.5 | shared | 636.8 / 665.3 | 773.6 / 1032.0 | 1018.8 / 1258.0 |
| OpenCode 2.2.0 | isolated | 382.2 / 363.5 | 1832.4 / 1812.2 | 3636.1 / 3622.3 |
| OpenCode 2.2.0 | shared | 381.8 / 363.7 | 449.0 / 461.0 | 489.4 / 510.3 |
| Antigravity 1.4.3 | isolated | 430.2 / 456.8 | 2132.2 / 2334.2 | 4267.4 / 4680.3 |
| Antigravity 1.4.3 | shared | 428.9 / 457.3 | 902.2 / 1224.0 | 1495.9 / 2193.2 |

Ten-session CPU windows and file descriptors (idle / after turn):

| Runtime | Mode | CPU, % of one core | File descriptors | Processes after turn |
| --- | --- | ---: | ---: | ---: |
| Codex 0.165.0 | isolated | 1.37* / 0.79 | 578 / 690 | 20 |
| Codex 0.165.0 | shared | 0.40* / 0.00 | 70 / 89 | 2 |
| Claude 2.1.312 | isolated | 13.90 / 16.89 | 140 / 149 | 10 |
| Kimi 2.3.3 | isolated | 63.14 / 40.78 | 220 / 220 | 10 |
| Kimi 2.3.3 | shared | 2.35 / 1.77 | 22 / 22 | 1 |
| Qwen 0.26.2 | isolated | 14.45 / 0.00 | 450 / 450 | 20 |
| Qoder 1.1.80 | isolated | 1.58 / 0.79 | 316 / 298 | 10 |
| Grok 1.0.70 | isolated | 1.38 / 0.99 | 270 / 280 | 10 |
| Grok 1.0.70 | shared | 0.20 / 0.40 | 99 / 100 | 1 |
| OpenCode 1.19.5 | isolated | 28.73 / 45.00 | 207 / 237 | 10 |
| OpenCode 1.19.5 | shared | 131.22 / 105.93 | 34 / 64 | 1 |
| OpenCode 2.2.0 | isolated | 27.18 / 13.66 | 330 / 330 | 20 |
| OpenCode 2.2.0 | shared | 1.98 / 3.95 | 33 / 33 | 2 |
| Antigravity 1.4.3 | isolated | 2.17 / 2.76 | 584 / 590 | 20 |
| Antigravity 1.4.3 | shared | 0.00 / 0.98 | 230 / 230 | 11 |

`*` marks CPU lower bounds because a process exited during the window. Full
one-session and five-session CPU/descriptor observations are in the JSON.

Closing one of ten shared ACP sessions produced these snapshots. The native
close succeeded in each case, but a small RSS change is not proof that all
session memory was returned to the OS.

| Runtime | Before close, MiB | After close, MiB |
| --- | ---: | ---: |
| Kimi 2.3.3 | 395.7 | 381.6 |
| Antigravity 1.4.3 | 2193.2 | 2191.8 |
| Grok 1.0.70 | 158.8 | 158.3 |
| OpenCode 1.19.5 | 1258.0 | 1247.5 |
| OpenCode 2.2.0 | 510.3 | 483.7 |

For Codex, `thread/unsubscribe` returned successfully but ten threads remained
loaded, including after an extra grace period. RSS was 218.0 MiB before
unsubscribe, 216.0 after it and 215.7 after the extra wait. Archiving one thread
left nine loaded and 218.1 MiB. Descriptor counts fell from 89 to 87. These
observations establish listener removal versus thread removal; they do not
establish proportional memory reclamation.

## Codex interruption and tool lifetime

Each case holds nine peer model streams open, interrupts the target, then
releases the peers and verifies all nine complete. Three fresh repetitions
were run for each case and each process mode:

- `stream`: target is streaming text, without a tool.
- `foreground`: a command has started a parent and child process, each with a
  45-second lifetime; its initial `exec_command` call is still waiting.
- `wait`: `exec_command` has returned a logical process ID, then the model
  invokes `write_stdin` to wait for its output.

| Mode | Target case | Interrupt to native/OAR turn end, ms | Tools alive at 2 s / 10 s | Peer turns completed |
| --- | --- | ---: | ---: | --- |
| native-shared | stream | 11.5 to 12.8 | 0 / 0 | 9/9 in each of 3 runs |
| native-shared | foreground | 13.5 to 59.6 | 2 / 2 | 9/9 in each of 3 runs |
| native-shared | wait | 11.6 to 14.2 | 2 / 2 | 9/9 in each of 3 runs |
| oar-isolated | stream | 13.3 to 22.9 | 0 / 0 | 9/9 in each of 3 runs |
| oar-isolated | foreground | 13.9 to 28.9 | 2 / 2 | 9/9 in each of 3 runs |
| oar-isolated | wait | 12.2 to 17.0 | 2 / 2 | 9/9 in each of 3 runs |

The tool cases kept both processes alive until their scripted natural exit,
about 45 seconds after interruption for foreground and 43.6 to 43.8 seconds
for the already-running wait case. The original “tools stopped within two
seconds” assertion therefore failed in both modes. It remains an explicit
negative result, not a passing cancellation guarantee.

The existing OAR ten-second abort fallback did not fire because the native
`turn/completed` notification had already arrived and ended the turn. Process
isolation alone does not change this abort behavior. Full session disposal is
a different operation from interrupting one turn.

In shared mode the command trees belonged to the same app-server process;
OS ancestry alone did not identify the thread. Native tool events and
`thread/backgroundTerminals/list` did expose a logical `processId`. The listed
`osPid` was null, so the implementation must not infer thread ownership from
an OS PID.

### Three distinct native operations

1. `turn/interrupt` ends the turn and its active wait. It does not clear the
   thread's unified-exec process store. Commands can remain available for
   subsequent `write_stdin` calls. This is consistent with the native
   cross-turn execution design, not evidence of an OAR-only leak.
2. `thread/backgroundTerminals/terminate {threadId, processId}` returned
   `{terminated:true}` and stopped the selected parent/child command tree
   in 46.8 to 48.4 ms in three repetitions. Nine peer threads completed
   normally in each repetition. This is the native exec handle, not the
   separate host-spawned `process/kill` or `command/exec/terminate` API.
3. `thread/archive` returned `{}` and stopped the target command tree in
   45.1 to 56.6 ms in three repetitions. A separate two-command case stopped
   four tool processes in 91.3 ms while all nine peers completed. History
   remained readable with the same thread ID. Repeating archive returned
   `no rollout found`; direct resume returned an archived-thread error.
   `thread/unarchive` followed by `thread/resume` restored the same ID,
   original user message and interrupted turn. Archive is therefore not an
   idempotent, state-neutral connection close.

These are observed outcomes, not a claim that archive always succeeds at
cleanup. In the pinned source, the archive path waits for shutdown but logs
and continues on a submission failure or shutdown timeout. A future shared
adapter must handle that failure boundary instead of assuming an archive
response proves all processes died.

[src] Checked against Codex tag `rust-v0.165.0`, commit
`360319d8dee62d87e2d59fc0c21805d79519cfed`:

- [`handle_task_abort` and background-terminal operations](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/core/src/tasks/mod.rs#L938): task cancellation and unified-exec cleanup are separate operations.
- [`shutdown_session_runtime`](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/core/src/session/handlers.rs#L293): shutdown calls the unified-exec manager's `terminate_all_processes`.
- [`thread_unsubscribe_response_inner` and `prepare_thread_for_removal`](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server/src/request_processors/thread_processor.rs#L1079): unsubscribe removes a listener; archive removes the loaded thread and requests shutdown, with the failure caveat above.

## ACP concurrency, cwd, MCP and cancellation

Kimi 2.3.3, Grok 1.0.70, OpenCode 1.19.5 and 2.2.0, and Antigravity 1.4.3 all
accepted concurrent `session/new` requests on one connection. In the 1/5/10
cohorts, each session received its own distinct answer and no other session's
answer. Separate two-session probes used different directories and two MCP
servers with the same configured name but different identity replies. The
provider verified actual shell cwd results and actual MCP results for each
session, not just requested configuration.

All five passed those observed isolation checks. Antigravity requires an
explicit `Cwd` in `run_command`, which the probe supplied; that row does not
prove implicit shell-cwd behavior. The terminal host used by the experiment
routes reverse requests by session ID, with per-session default cwd and
owned terminal sets. A future shared host must preserve this routing.

| Runtime | Cancel to prompt end, ms | Tools alive at 2 s / 10 s | Tools alive 2 s after native close | Peer usable after close |
| --- | ---: | ---: | ---: | --- |
| Antigravity 1.4.3 | 9.0 | 0 / 0 | 0 | end_turn |
| Grok 1.0.70 | 4.0 | 2 / 2 | 2 | end_turn |
| Kimi 2.3.3 | 14.2 | 0 / 0 | 0 | end_turn |
| OpenCode 1.19.5 | 91.2 | 0 / 0 | 0 | end_turn |
| OpenCode 2.2.0 | 22.6 | 0 / 0 | 0 | end_turn |
| Grok with host terminal disposal | 1.9 | 2 / 2 | 0 | end_turn |

All target prompts reported `cancelled`, all held peers waited until their
explicit release, and every peer completed a further prompt after target
close. Kimi, OpenCode and Antigravity had no live target tools at the first
two-second observation. The later `toolsStoppedByMs` JSON field is only an
upper-bound observation timestamp, not their actual exit latency.

Grok returned `x.ai/closeOutcome: closed`, yet its host-created parent and
child kept running and exited naturally at about 44.9 seconds after cancel.
The second Grok control called only the target session's terminal-host
`dispose()` after native close; both tools were gone at the next observation,
and the peer remained usable. Thus native close alone is insufficient for
Grok's terminal cleanup, but the host has explicit ownership information.

These are small probes, not a stress or security-isolation proof. Kimi, Grok,
OpenCode v1 and Antigravity each had two complete isolation runs; OpenCode v2
had one valid run after correcting the fixture mistake below. Other tool
kinds, arbitrary extensions, crashes, concurrent close/resume and resource
exhaustion remain untested.

## Retained unsuccessful attempts

- The first Kimi resource setup omitted a fixture callback and failed before
  starting a native session. Corrected setup produced the measured cohorts.
- The first shared Codex observation failed on a procfs descriptor `EACCES`.
  The observer now records denied reads as unknown, while the original failed
  attempt remains in the local artifacts.
- The first Kimi shared-answer matcher inspected the last user message, which
  was Kimi's injected date reminder. Matching the unique marker anywhere in
  the request produced the valid cohorts; the original turns were retained.
- The first OpenCode v2 isolation fixture sent v1 `bash` and MCP tool names.
  The native runtime refused them. Using v2's `shell` and `execute` with
  `tools.scope.echo(...)` passed. This was a fixture error, not evidence of a
  catalog race or cancellation failure; no native retry or delay was added.
- The Codex two-second tool-stop assertion failed in both shared and isolated
  modes. Extended observations and native cleanup controls explain that
  failure rather than hiding or relaxing it.

## Reproduce

Run from the repository with Node 24+, pnpm dependencies, Linux procfs and
Python 3. Set absolute `OAR_CODEX_BIN`, `OAR_CLAUDE_BIN`, `OAR_KIMI_BIN`,
`OAR_QWEN_BIN`, `OAR_QODER_BIN`, `OAR_GROK_BIN`, `OAR_OPENCODE_BIN` and
`OAR_ANTIGRAVITY_BIN` paths for the installed versions to compare. No login
is needed. Each command writes a fresh output directory; failed evidence is
written before the script rejects where the native setup reached that stage.

```sh
pnpm tsx experiments/runtime-resources.ts oar-trial-run/resources codex claude kimi qwen qoder codex-shared
pnpm tsx experiments/runtime-resources.ts oar-trial-run/acp-isolated grok opencode antigravity
pnpm tsx experiments/acp-shared-resources.ts oar-trial-run/kimi-shared kimi 1 5 10
pnpm tsx experiments/acp-shared-resources.ts oar-trial-run/grok-shared grok 1 5 10
pnpm tsx experiments/acp-shared-resources.ts oar-trial-run/opencode-shared opencode 1 5 10
pnpm tsx experiments/acp-shared-resources.ts oar-trial-run/antigravity-shared antigravity 1 5 10
pnpm tsx experiments/acp-shared-isolation.ts oar-trial-run/kimi-isolation kimi
pnpm tsx experiments/acp-shared-isolation.ts oar-trial-run/grok-isolation grok
pnpm tsx experiments/acp-shared-isolation.ts oar-trial-run/grok-dispose grok --dispose-target-terminals
pnpm tsx experiments/acp-shared-isolation.ts oar-trial-run/opencode-isolation opencode
pnpm tsx experiments/acp-shared-isolation.ts oar-trial-run/antigravity-isolation antigravity
pnpm tsx experiments/codex-shared-interrupt.ts oar-trial-run/codex-stream native-shared stream 1
pnpm tsx experiments/codex-shared-interrupt.ts oar-trial-run/codex-wait native-shared wait 1
pnpm tsx experiments/codex-shared-interrupt.ts oar-trial-run/codex-isolated oar-isolated wait 1
pnpm tsx experiments/codex-shared-interrupt.ts oar-trial-run/codex-terminate native-shared wait 1 terminate
pnpm tsx experiments/codex-shared-interrupt.ts oar-trial-run/codex-archive native-shared wait 1 archive 2
```

The two `wait` commands without cleanup intentionally reject the two-second
“tools stopped” expectation on this Codex version, after retaining the natural
exit observation. Repeat with `foreground`, and repetition numbers 1 through 3,
for the full interruption matrix. Run the OpenCode commands separately with
the v1 and v2 absolute binary overrides and different output directories.

## Decision boundary

The observations show a substantial memory opportunity and working native
session addressing. They do not justify a generic “one process is safe”
policy. Codex needs native command ownership plus archive/unarchive semantics
and explicit handling of shutdown failures. Grok needs host terminal disposal
by session ID. The other ACP runtimes passed this small isolation matrix but
still need lifecycle failure and platform coverage before a default change.
No process reuse, public resource API or abort-contract changes are made by
this report. The existing abort wording should distinguish turn completion
from tool termination, independently of whether reuse is implemented.
