# OpenCode

Independent inventories: not implemented for OpenCode yet.
See the [query contract](../spec/inventory.md) and [native probe evidence](inventory.md).

The installed executable selects the adapter behavior: v1 (`opencode-ai`)
and v2 (`@opencode/cli`) share the `opencode` runtime ID. OAR preserves the
reported version string verbatim, including v2's `opencode v` prefix. Updating
within a line and migrating to another line are separate user decisions.
The sections below describe v1 unless they explicitly name v2.

Evidence baseline: **opencode 1.18.30** (linux x64, `opencode acp`, the free
model `opencode/big-pickle` with no login) on 2026-10-06 through
[`experiments/live-contract.ts opencode`](../../experiments/live-contract.ts)
(13/13, scenario names in parentheses below), the
[vendor snapshot](../../tests/replay/fixtures/opencode-acp-v1.vendor.json)
from [`experiments/acp-vendor-snapshot.ts`](../../experiments/acp-vendor-snapshot.ts),
and direct ACP probes of the same binary for model switching, effort and
resume. Source was read at **v1.18.34** (`anomalyco/opencode`,
`packages/opencode/src/acp/`, `session/prompt.ts`); where only the source
says so, the statement is marked [src]. The
[HTTP server section](#the-http-server-investigated-2026-09-12) is the
earlier investigation of the same version through `opencode serve`.
Versions are evidence baselines, not a support range; see the
[runtime index](README.md) for status conventions.

Later v1 releases were rechecked on Linux x64 without adapter changes; no
recheck repeats the direct model-switching probes or the HTTP-server
investigation. Latest: **1.19.5** (2026-10-28) passed 10 native vendor
tests, 17 shared behavior cases (two skipped), the prompt-options probe and
a nine-model catalog on the first run against local scripted providers,
without an account
([October 28 report](../../experiments/runtime-version-checks/2026-10-28.md#opencode-1195)).
Native startup failures on v1 are under
[startup and compatibility](#startup-and-compatibility).

## First-prompt snapshot cost (v1)

On Windows CI, OpenCode **1.19.5** took **9.236 to 158.806 seconds** in
its first directory snapshot across sixteen successful vendor fixtures run
in the OAR Git checkout (2026-11-06). Native logs place that interval
between `initialized` and `tracking`, before the agent's model request; in
the fifteen samples with a later agent `stream` record, it followed about
0.9 to 1.8 seconds later. The wait can look like a stalled prompt while the
native process prepares its snapshot. These are measured samples, not a
latency guarantee or an explanation of all OpenCode timeouts; Git, disk and
scheduling costs were not separated
([evidence and reproduction](../../experiments/acp-ci-failures/opencode-snapshot.md)).

OAR does not change the native `snapshot` setting; hosts tune it in their
own OpenCode configuration. The MCP and failure-class vendor fixtures use
small temporary Git projects so they do not wait for snapshots of the OAR
checkout; native snapshots stay enabled.

For a prompt failure reported as JSON-RPC -32603, a known `data.errorName`
decides the class before the words: `provider.free-limit`, `provider.go-limit`,
`provider.budget-limit`, `provider.model-budget-limit` and `provider.quota` are
`quota`, `provider.rate-limit` is `rate_limited` (names from the 2.2.6 source).
Any other answer, `APIError` included, is classified by its words. PR #710
reports a live `provider.free-limit` observation; the
[November 9 local-provider check](../../experiments/opencode-error-names/README.md)
also captured native 2.2.6's `provider.rate-limit`. The other four quota names
remain source-derived, with synthetic mapping tests. The shared profile
applies this rule to both release lines and leaves open-time errors unchanged.

## Manual compaction

The v2 session exposes idle-only `compact()` through native `/compact`.
`session_info_update._meta["opencode/compaction"]` supplies status, messageId
and reason; OAR projects that messageId as `compactionId` on start and end
events, automatic ones included. The manual control binds the first manual
start in its exclusive idle window and requires the same identity at
completion. The correlated prompt RPC answer (`responseTo`) releases the gate
and status together, after preceding markers. Wrong, old and absent ids
cannot establish completion: an answer without a matching marker returns
unconfirmed, and a native RPC error is retained as a frame and returns failed.
Response usage follows the ordinary profile projection when supplied; missing
counts are not inferred. Ordinary `end_turn` does not prove success: on
2.2.5, provider errors, invalid summary headings and empty history all
produced structured failed markers alongside an ordinary success answer.
Cancellation supplies `error.type: aborted`. Same-name configured commands
did not override the native compact path in the control.

V1 sessions have no `compact()`: a project command can replace `/compact`,
and its structural completion is unverified. The shared v1/v2 Runtime does
not declare `manualCompaction`; inspect the opened session
([2.2.5 evidence and limitations](../../experiments/manual-compaction-followup-2026-11-02.md)).

## Windows isolated-process cleanup

Disposing an active tool can stop OpenCode's shell before its tool and child
exit. OAR captures descendant start identities before the existing native
cancel/close operations, then revalidates and cleans remembered descendants
after the root exits. After an OAR stop action, a process-table read failure
is reported as unverified cleanup; a prior natural exit keeps its native
error without a cleanup suffix. This uses the common Windows process-tree
fallback; it adds no native close operation and does not enable sharing.
The [Windows baseline and regression](../../experiments/windows-orphan-cleanup.md)
retain the main-branch reproduction and the native isolated lifecycle check
that CI runs.

## OpenCode v2

### Shared-process admission boundary

`opencodeRuntime` opens an isolated process for every `auto` request and
refuses explicit `shared` with `UnsupportedOptionError`, option `placement`,
on all versions and platforms. The standalone `opencodeSession` export is
isolated. Sharing for 2.2.3 and 2.2.5 was withdrawn in 0.83.0
([#587](https://github.com/botiverse/oar/pull/587)): configured user or
project plugins can start children that inherit the shared process HOME
instead of the session directory, and OAR cannot discover all such
configuration from session options
([native counterexample and withdrawal](../../experiments/sharing/opencode-plugin-environment-2026-10-31.md)).

The shared adapter described below is retained for experiments only and
does not authorize production sharing: production admission never selects
it, and only
[`experiments/sharing/opencode-candidate.ts`](../../experiments/sharing/opencode-candidate.ts)
admits sessions to it. The candidate requires exact native 2.2.3 or 2.2.5 on Linux
x64, macOS arm64 or Windows x64 (the host Node process's platform and
architecture, not the physical machine's), then independently requires the
same exact versions in `initialize.agentInfo.version`. A mismatch retires
the process before opening any session.

In native 2.2.3 and 2.2.5 ACP, two sessions in the same directory with the
same MCP server name and different command arguments share the later
registration: after B opens, A invokes B's server. Closing A/B and opening
the directory with no client MCP servers still invokes B's server.
Separate-process controls do not cross. The
[official ACP documentation](https://opencode.ai/v2/docs/cli/acp#MCP-servers)
describes directory-scoped registration, same-name replacement and retention
until the ACP process exits, so this is documented native scope, not an
unreported upstream defect. Reproduce with
`pnpm tsx experiments/sharing/same-directory.ts opencode` and the exact
2.2.3 or 2.2.5 executable; [results and limits](../../experiments/sharing/admission-2026-10-31.md).

The shared adapter gives each canonical directory to only one session for
the entire process lifetime; the directory remains used after that session
releases. A later same-directory open, even with an identical or empty MCP
list, uses a fresh isolated process for `auto` and refuses explicit
`shared` with `UnsupportedOptionError("placement")`. The earlier
different-directory MCP evidence cannot establish unrestricted
same-directory sharing. The [2026-10-31 admission report](../../experiments/sharing/admission-2026-10-31.md)
observed cross-directory project discovery and user-configuration refresh
separately for 2.2.3 and 2.2.5 on Linux x64, macOS arm64 and Windows x64.
Those controls omitted plugin child environment and do not establish
admission, even with the lifetime directory restriction. See the
[ACP ownership spec](../spec/acp-shared-connection.md).

### Experimental shared launch, ownership and cleanup

Each Runtime instance owns a separate pool, including every instance returned
by `withPlacement()`. To share, the command, `acp` arguments, complete
captured child environment (inherited values plus overlay/removals), process
cwd and initialize metadata must match. Environment comparison includes
HOME/USERPROFILE, all XDG directories, configuration overrides and
credentials; private pool keys are never recorded. Initialization happens
once, including concurrent first opens. The native ACP process owns its
standalone server.

The shared launch uses the effective HOME on POSIX or USERPROFILE on
Windows (the host's home if absent) as its stable process cwd, as in the
native evidence. Project cwd travels in `session/new` or resume/load, and
native project catalogs/configuration use that session location. Model,
effort and MCP inputs remain native session operations. The audit inspected
2.2.3's `commands/handlers/acp.ts`, `services/standalone.ts`,
`acp/service.ts`, `acp/sessions.ts`, `acp/catalog.ts` and
`core/config/discovery.ts`; project discovery and user refresh were then
[observed on all three platforms](../../experiments/sharing/admission-2026-10-31.md).

Custom `launchArgs`, a relative executable path, relative home/configuration
paths or relative PATH entries lack that neutral-directory launch evidence:
`auto` uses the isolated launch and explicit `shared` refuses. Empty PATH
entries count as relative, so a trailing `;` on Windows and the
`./node_modules/.bin` entry inserted by pnpm 11 both disable sharing. Such
entries are never silently interpreted relative to the shared process home.
The experiment's fixtures supply only absolute PATH entries; this does not
bypass the public admission refusal. The runtime does not write user
configuration, retry failed native opens, or serialize unrelated pools to
hide the known database race.

Before native opening, cwd is resolved through symlinks for ownership only.
Native session arguments and isolated fallback preserve the host's original
cwd spelling, including symlinks and Windows short paths. The connection
reserves both the canonical path and directory file identity, so aliases
on case-insensitive macOS/Windows volumes cannot acquire a second session.
Windows path keys are conservatively case-folded; file identity preserves
distinct directories on case-sensitive POSIX volumes. Reservation is atomic
after asynchronous filesystem reads, survives failed opens and release, and
disappears only with the native process. An auto fallback waits for the
existing pool's initialization, even a failed one, before starting its
independent process, and reports its own failure if that process cannot
start. A controlled resume id still fails with `SessionUnavailableError`
before any directory fallback; native open/configuration failures do not
retry in isolation.

Disposal and abort fallback use native `session/close` for that session and
independently release its OAR-hosted terminals. Close interrupts the native
turn and detaches its subscription, but does not erase the directory's MCP
registration. Failures remain `cleanup` records. Child identity uses only
`_meta["opencode/child-session"]` parent/id links owned by the carrier's
root; rejected or temporarily unresolved metadata stays native-only, without
child projection, and later links do not retroactively project earlier
frames. Unowned and conflicting connection frames are union-redacted, never
assigned to an arbitrary root. The default diagnostic sink keeps only reason
counts and writes at most one summary every 30 seconds per Runtime instance,
prefixed `[oar:opencode:shared]`, without frame bodies. The first summary is
immediate; a pending summary uses one unreferenced timer, so diagnostics do
not keep the host alive. Counts are best-effort and are not session records.

Peers keep their process on release/disposal. Only the last lease stops it;
actual exits fan out once to attached sessions. After abort-fallback release,
late frames remain recorded and new controls are rejected. Dispose detaches
routing; later traffic becomes connection diagnostics. A native turn or work
started after the last cleanup may continue. Resource readings describe the
whole shared process (`scope: "shared_process"`); Windows still returns
null. Open request and observed placement, release, cleanup and actual exit
use the [record-stream contract](../spec/record-stream.md#placement-and-release).

The manual `opencode-sharing-experiment.yml` workflow runs this experimental
adapter on real 2.2.5: the full session behavior suite with fresh, distinct
directories through `opencode-shared`, real shared and isolated controls for
concurrent roots, model/cwd/MCP, child attribution, cancel, tool cleanup,
peer survival and isolated resume after release, and the plugin
child-environment comparison. The model provider is local and scripted; the
CLI and its processes are real. The default CI check jobs run only the real
isolated tool-cleanup check (`@opencode/cli@2.2.7`).

### Startup and compatibility

The v2 adapter's ACP subprocess owns a standalone native server; OAR does
not connect to or leave a persistent daemon. Latest recheck: **2.3.0**
(Linux x64, 2026-11-13) passed fifteen behavior cases and the twelve-model
catalog and prompt-option refusal controls. Native background child
updates require an explicit capability and the
`opencode/session/child_update` extension
([paired native evidence](../../experiments/opencode-child-background/README.md)).
OAR declares that capability on 2.3 and later and maps the extension
([background children](#v2-session-behavior)). Before that mapping the
cleanup control stopped at the missing child graph edge; with it (PR #775
review, Linux x64, 2026-11-13) the control passed on 2.3.0 with only its
test title and version assertion changed from 2.2.7 (lifecycle assertions
and time limits unchanged): child edge, root cancellation, real tool
parent and child process disposal, the surviving peer and same-id root
resume. The unmodified 2.2.7 control passed on the same head. CI remains on
2.2.7.

The **2.2.7** recheck
(Linux x64, 2026-11-10) passed all fifteen applicable behavior cases and
[the isolated native cleanup control](../../sea-trial/vendor/opencode-cleanup.vendor.test.ts)
(routed roots, MCP, children, cancellation, peer survival and resume); the
cold catalog returned twelve models and both prompt-option refusals passed.
The [daily report](../../experiments/runtime-version-checks/2026-11-10.md#opencode-227)
separates these checks from the known v1-only vendor failures and retains
the cold-start failure below. Cold MCP resume passed on 2.2.7
([v2 session behavior](#v2-session-behavior)). The
[boundary probe](../../experiments/opencode-release-lines.ts) last ran in
full on 2.2.5 ([October 31](../../experiments/runtime-version-checks/2026-10-31.md#opencode-225)):
nine of ten checks passed, cold MCP resume failed.

**Known limitation: concurrent first starts over a fresh native database can
fail before readiness**, confirmed by native SQLite errors. On 2.3.0,
three of four native concurrent first starts failed with a table-creation
conflict, while two serial and four prepared starts succeeded; both cold
and both prepared ACP opens succeeded
([November 13 report](../../experiments/runtime-version-checks/2026-11-13.md#opencode-230)).
On 2.2.7,
one of four concurrent native starts failed with `table account_state
already exists`; two serial starts and four concurrent starts after
initialization succeeded. The separate ACP probe failed one of two cold
opens with only a readiness error, while both prepared opens succeeded
([November 10 report](../../experiments/runtime-version-checks/2026-11-10.md#opencode-227)).
On 2.2.6, one
of two concurrent fresh-database ACP opens exited before readiness and both
opens after serial initialization succeeded
([November 7 report](../../experiments/runtime-version-checks/2026-11-07.md#opencode-226));
its retained stderr says `Standalone server exited before reporting
readiness`, with no native SQLite error, so that sample does not establish
the same cause. The OAR-free startup probe started four native servers
simultaneously against a fresh database: on 2.2.5 two exited 1 with
`table account_state already exists`
([October 31 report](../../experiments/runtime-version-checks/2026-10-31.md#native-startup));
on 2.2.3 two became ready, one exited 1 with `database is locked` and one
with `table account_state already exists`
([October 30 report](../../experiments/runtime-version-checks/2026-10-30.md#native-startup));
the 2.2.1 batches failed one of four and three of four with the
account-state error (2.2.2 not tested). On 2.2.3 and 2.2.5, two sequential
starts and four concurrent starts over an initialized database succeeded. On 2.1.4 and 2.2.0 the first behavior-suite run failed one case
before server readiness (2.2.0's saved native log reports `SQLiteError:
database is locked`) and the unchanged recheck passed
([2.1.4](../../experiments/runtime-version-checks/2026-10-23.md#opencode-startup-and-compatibility),
[2.2.0](../../experiments/runtime-version-checks/2026-10-27.md#opencode-220)).
See [upstream issue 53879](https://github.com/anomalyco/opencode/issues/53879).
The inspected 2.2.1 bootstrap semaphore is process-local. These observations
do not establish that every startup failure has this cause, or that warmup
is a general fix. Hosts can serialize the first startup and wait for
readiness before opening more sessions against the same data directory, as
in the passing controls. OAR adds no retry or lock.

v1 shows startup exits too. On 2026-10-30 a local Linux x64 run on xxwork
with **1.19.5**, a fresh isolated HOME/XDG data directory and the scripted
provider scheduled 17 applicable behavior cases concurrently (16 session
cases and one installation probe). `session.queue-runs-after-turn` lost its
native process before opening a session; it exited with code 1 and no
signal. The bounded stderr captured by OAR's ACP opening diagnostics
contained this excerpt (ANSI formatting removed, remaining schema omitted):

```text
Error: Unexpected error
Failed query:
        CREATE TABLE `workspace` (
```

This identifies a failed schema creation statement, consistent with
upstream issue 53879; it does not identify `already exists` or `database is
locked` as that run's precise SQLite cause. On 1.19.4 one native startup
failed a workspace-table creation statement, cause not identified
([October 23 report](../../experiments/runtime-version-checks/2026-10-23.md#opencode-startup-and-compatibility)).
OAR's own
[Linux 1.19.5 CI job](https://github.com/botiverse/oar/actions/runs/40983609942/job/123829294049)
ran two cases concurrently and lost `session.dispose-is-recorded` before a
session opened (exit 1; 16 passed, two skipped, one failed); that run did
not retain native stderr, so its database cause is unconfirmed. These
observations do not establish that every startup exit has one cause.

### v2 session behavior

Bullets that name no version come from the boundary probe (2.0.26 through
2.0.29; it last passed all ten checks on 2.0.29,
[October 14 report](../../experiments/runtime-version-checks/2026-10-14.md))
and the [original 2.0.26 investigation](../../experiments/opencode-v2-2026-10-09.md),
which separates observations from source findings.
[October 12 evidence](../../experiments/runtime-version-checks/2026-10-12.md)
covers 2.0.27.

- **Control:** v2 refuses a concurrent `session/prompt`. Mid-turn input
  uses the steering extension below where `initialize` advertises it;
  otherwise the session has no `steer` member and `steerOrQueue` and
  `deliver` queue the input for another turn. Queueing remains an OAR memory
  FIFO, not durable native storage. Native abort and disposal during a
  shell call both ended as `aborted`.
- **Steering (2.2.7 and later), native interface:** `_session/steering`
  with `{ sessionId, prompt }` (ACP prompt blocks), which the source calls
  an interim extension until ACP has native mid-turn steering. It is absent
  from `packages/cli/src/acp/agent.ts` at tags v2.0.0, v2.0.16, v2.0.32,
  v2.1.0, v2.1.4, v2.2.0, v2.2.4, v2.2.5 and v2.2.6, and present at v2.2.7
  and v2.3.0. From v2.2.7, `initialize` advertises it in its top-level
  `_meta: { steering: { supported: true } }` (`service.ts`); the recorded
  native 2.3.0 answer in
  [`enabled.json`](../../experiments/opencode-child-background/enabled.json)
  carries it. Per `turn.ts` `steer` at `a6b15d33` [src]: when the server
  lists no running turn for the session, the agent answers
  `{ outcome: "promptRequired", reason: "noRunningTurn" }` and starts
  nothing; otherwise it submits the input with `delivery: "steer"` and
  `resume: false` and answers `{ outcome: "injected" }`. The request has no
  input identity field, and `translate.ts` emits no echo of the steered
  message.
- **Steering, OAR mapping:** the gate is the advertised capability, not the
  version: a v2 session has `steer` only when its `initialize` answer
  carries `_meta.steering.supported: true`, so 2.2.6 and earlier, and the
  shared 2.2.3/2.2.5 candidate, keep the host queue. `steer` sends the
  request only while OAR's own turn runs without a pending abort, rechecked
  at dispatch; otherwise it is `rejected` / `no_active_turn` with no native
  request. The answer is one frame (`type: "_session/steering"`, `native`
  verbatim, `responseTo` the steer request). `injected` is `accepted`: the
  input joins the running turn, which still ends with the original prompt's
  answer, and its `inputId` stays on OAR's steer request (no native
  correlation). `promptRequired` is `rejected` / `no_active_turn`, so
  `steerOrQueue` queues and `deliver` retries. A JSON-RPC error is
  `runtime_refused` with a `_session/steering/error` frame; any other
  outcome is `rejected` / `error`, since OAR cannot tell whether the input
  was taken. With `steer` present, `deliver({ when: "now" })` and
  `steerOrQueue` steer into a running OAR turn, and `when: "interrupt"`
  steers instead of withdrawing, aborting and merging.
- **Steering, races and limits:** a turn that ended before dispatch gets no
  request. A native turn that ended while OAR's prompt is still unanswered
  gives `promptRequired`; `deliver` then prompts once the status is idle, or
  queues while the status still shows that turn. Per the source comment, a
  session that goes idle between the agent's check and its submission keeps
  the steer queued natively and still answers `injected`: OAR reports
  `accepted`, but that input would wait for the next native turn (not
  exercised). During the parent's own reply (below) OAR has no turn, so no
  steering request is sent although the status says `running`; `deliver`
  queues and the adapter queue sends the input at once, as before. The
  [replay](../../tests/opencode/background-own-reply.test.ts) pins that
  case from the recorded 2.3.0 wire, and
  [`acp-session-opencode-v2-steer.test.ts`](../../tests/acp/acp-session-opencode-v2-steer.test.ts)
  covers each answer against a scripted agent. Not yet verified against a
  native 2.2.7 or 2.3.0 process: that an injected steer reaches the running
  turn's next provider request, its timing against a long tool call,
  whether it survives `session/cancel`, image blocks, and a slash command
  sent as a steer.
- **Children (verified through 2.2.7; 2.3.0 uses the background mapping below):**
  standard updates arrive on the parent's envelope with
  `update._meta["opencode/child-session"]` (`id`, `parentID`, `depth`,
  `title`). OAR records them under the named child session, links its real
  parent with `session_linked { parent, child, via: "tool_call" }` on the
  first update frame naming that pair in this stream, and declares `nested`
  attribution. Later updates do not repeat the edge. `graphOf(records)` preserves
  those edges in replay, including nested descendants. Child text, tools
  and usage do not become root output. Native notifications remain
  verbatim. The native tool `name` wins over its display title, so a
  child's `shell` stays `shell` even when its title has a child prefix.
- **Background children (2.3.0), native interface:** `subagent` always
  runs in the background and returns at once with
  `rawOutput.metadata.sessionID` (the child) and `status: "running"`; a later
  call with that `sessionID` sends the child a follow-up. The standard child
  projection above only applies while the creating prompt is active. A client
  that declares `clientCapabilities._meta["opencode/child-session-updates"]: true`
  receives every child update as `opencode/session/child_update` instead,
  never on both channels. Its params carry `rootSessionId`, `childSessionId`,
  `parentSessionId`, `depth` and `title`; `type: "update"` holds a
  SessionUpdate that keeps `_meta["opencode/child-session"]` and prefixes
  child tool call IDs, and `type: "status"` reports `created`, `running`,
  `completed`, `failed` or `interrupted`. There is no parent tool call ID.
  The 2.2.5 and 2.2.7 sources already read the same capability and switch
  channels, so OAR declares it only when the installed version is 2.3 or
  later; older lines keep the mapping above. Sources at `a6b15d33`:
  `packages/cli/src/acp/{capabilities,child,translate}.ts` and
  `packages/core/src/tool/plugin/subagent.ts`
  ([evidence](../../experiments/opencode-child-background/README.md#source)).
- **Background children (2.3.0), OAR mapping:** each notification is one
  frame (`type` is the method, `native` verbatim). An `update` is projected
  by the shared ACP projection as the child's own `session/update` and
  recorded under `childSessionId`, so child text and tools look as they do
  above. A `status` is the parent's task, recorded on `parentSessionId`'s
  envelope: `created` is `task_started` (`taskId` and `childSessionId` are
  the child, `taskType: "agent"`, `background: true`, `title` as its
  description), `running` is `task_updated` running (also for a follow-up
  to a finished child), `completed` is `task_ended` completed, `failed` is
  failed and `interrupted` is stopped. The task has no `toolCallId`. The
  `session_linked` edge needs two native facts in either order: a tool call
  in the parent session whose `rawOutput.metadata.sessionID` names the child,
  and a child notification naming that parent. It is recorded on whichever
  frame completes the pair; in the recorded run that is the `subagent`
  call's completed update, one millisecond after `created`. Without that
  output the child's records still carry its own session ID, a graph node,
  but no edge is recorded and no tool ID is invented. Once a child has used
  the extension, a standard copy of its update stays verbatim without
  events (none was observed). Nested children use their `parentSessionId`
  and the middle child's own tool output. In the
  [recorded run](../../experiments/opencode-child-background/enabled.json)
  the parent prompt answered at 1695 ms, then child text and completion
  arrived at 1706 and 1707 ms; OAR records them after the root `turn_ended`,
  under the child and as the parent's task, without reopening or ending the
  root turn. Shared placement admits only 2.2.3 and 2.2.5 and never declares
  the capability.
- **Background children (2.3.0), verification:** the two recorded native
  runs replay through the real session, projection and record stream in
  [`background-child.test.ts`](../../tests/opencode/background-child.test.ts):
  one level, text only. Tool calls inside a child, permissions, `failed`,
  `interrupted`, resume and depth > 1 were not exercised natively; the
  nested case is a synthetic test of the source's shape.
- **Background children (2.3.0), the parent's own reply (known gap):** after
  a child completes, OpenCode gives the parent model a `<subagent>` report
  and the parent answers on its own, with no `session/prompt`. That reply
  arrives as ordinary root `session/update` frames after the prompt
  answered, with or without the capability. ACP exposes neither its start
  nor its end. In both recordings it is one `agent_message_chunk` with a new
  `messageId` (`message-5` enabled, `message-4` disabled), followed by no
  `usage_update`, `session_info_update`, extension notification or other
  frame for the remaining 60 seconds. A new `messageId` also occurs inside
  ordinary prompted turns, so it marks neither boundary. The source at
  `a6b15d33` explains why: after the prompt answers, `turn.ts` `handoff`
  keeps a background follower (`followChildren`) with no prompt start. It
  forwards only the translated updates. The root `session.execution.*`
  terminal in `translate.ts` `rootEvent` produces no ACP output, and
  `sendUsageUpdate` runs only when a prompt settles. OAR therefore records
  each frame verbatim and adds no turn boundary. The status fold adopts the
  reply as a running turn with no `requestId` or `inputId` (`sinceSeq` is
  the reply's first frame, `lastEventAt` its latest). That status stays
  `running` until a later native end, which in practice is the answer to
  the next host prompt. Consequences: `awaitIdle` and
  `deliver({ when: "when_idle" })` wait until that answer; `stallOf`
  reports the silence. No OpenCode profile maps runtime turns, so OAR's
  turn driver has no open turn: `prompt()` is admitted although status
  says `running`, and `deliver()` lands `queued` but the adapter queue
  sends it at once. This is a
  [documented exception](../spec/manual-compaction.md#ownership-records-and-state)
  to status and prompt admission agreeing. OAR does not settle the reply
  after silence or a deadline. Per the source, OpenCode submits every
  prompt with `delivery: "steer"`; if the reply is still running, the
  prompt joins it and is answered when that native execution ends (not
  exercised natively). A native 2.3.0 control, with and without the
  capability, sent a follow-up after the reply: it ended and status
  returned to `idle`. The replay in
  [`background-own-reply.test.ts`](../../tests/opencode/background-own-reply.test.ts)
  pins this from the recorded wire (including a pending `awaitIdle` and a
  `when_idle` delivery dispatched only after the follow-up's native end), with a synthetic answer to the
  follow-up. Closing the gap needs a native end report for runtime-started
  root turns.
- **Tool names:** `shell` is a command with its reported `command` input;
  v1 `bash` remains supported. `subagent` classifies as `subagent`, with
  its `description` as the detail. Code Mode `execute` retains its name and
  classifies as `other`: it can run MCP calls, ordinary
  JavaScript or `fetch`; the name alone cannot prove an MCP operation.
- **MCP:** stdio and HTTP servers supplied at new and resumed session open
  are callable through `execute`, whose input code, result and native metadata
  are retained, including the names of enclosed MCP calls.
  **Cold resume:** on 2.2.6 the [November 7 local-provider check](../../experiments/opencode-mcp-resume-2026-11-07.md)
  called echo on all 20 cold resumes per transport and in both warmed
  initial sessions, with no model-visible catalog-removal notice (Linux x64,
  immediate scripted tool calls; not a guarantee for every provider,
  platform or catalog timing). The [2.2.7 recheck](../../experiments/runtime-version-checks/2026-11-10.md#opencode-227)
  passed both initial sessions and six cold resumes per transport, again
  without a removal notice. The
  [same probe on 2.2.5](../../experiments/runtime-version-checks/2026-11-06.md#opencode-225-cold-mcp-resume-after-upstream-closure)
  called echo in both initial sessions but on none of six cold resumes, the
  model seeing a notice that removed the reattached tool. Earlier
  intermittent failures were also reproduced
  [without OAR](../../experiments/opencode-mcp-resume-native.ts) and
  [independently upstream](https://github.com/anomalyco/opencode/issues/54794#issuecomment-6123225428);
  [upstream #54794](https://github.com/anomalyco/opencode/issues/54794) is
  closed. The verified boundary is 2.2.5 failed, 2.2.6 passed (2.2.4 not
  tested); [OAR #371](https://github.com/botiverse/oar/issues/371) keeps the
  earlier failure history. OAR adds no retry, sleep or catalog filtering for
  this behavior.
- **Prompt options:** both `systemPrompt` and `appendSystemPrompt` are
  refused before ACP startup, including resume. The v2 instruction loader
  does not consume the v1 `instructions` configuration. v2 has native
  `agents.<id>.system`, but OAR has not verified a safe session-local path
  that resolves the actual agent on both creation and resume. This is an
  adapter boundary, not a claim that v2 lacks system prompts; configure
  v2's native settings directly when those settings are intended.
- **Models:** queries use `models --standalone`, never `--verbose` or a
  persistent service. On 2.0.27 through 2.0.30 and on 2.0.32, cold queries
  in fresh native configurations returned a nonempty catalog, which OAR
  returns as `ok` without an adapter change (on 2.0.27 two fresh
  configurations each returned the same 11 IDs,
  [October 12 evidence](../../experiments/runtime-version-checks/2026-10-12.md);
  ten IDs on 2.0.32,
  [October 17 report](../../experiments/runtime-version-checks/2026-10-17.md)).
  On 2.0.26 the cold query returned no models; an empty native response
  still becomes `unsupported`, not `ok` with zero models
  ([upstream issue #53724](https://github.com/anomalyco/opencode/issues/53724)).
  OAR creates no throwaway session for a read-only query. A nonempty native
  listing supplies IDs only; no effort menu is fabricated. The separate
  `api agent.list --standalone` empty result was observed on 2.0.26 and not
  re-probed since.
- **Defaults and configuration:** on 2.0.26 the native default model was
  `opencode/exo-free`, and the initial effort was `default`; these are
  observations, not OAR defaults. v2 can rewrite v1's `autoupdate` config
  into `update` on its first launch. OAR does not migrate or rewrite that
  user configuration. Explicit model selection still uses native readback.
- **Interaction limits:** no elicitation capability is advertised. v2's
  question path remains outside the verified host-answer contract.

## Provider authentication

OpenCode 2 signs in per provider ("integration"): OpenAI, GitHub Copilot,
xAI, API keys and so on.
`createOpencodeProviderAuth(installation, { env?, timeoutMs?, loginTimeoutMs?, idleMs?, loopback? })`,
exported from `@botiverse/oar` and `@botiverse/oar/runtimes/opencode`,
returns the same `ProviderAuthFacade` as `createPiProviderAuth`, plus
`close()`. It drives only OpenCode's own HTTP API and never reads or writes
OpenCode's credential files. OpenCode 1 has no such API: it is refused with
`OpencodeProviderAuthError` kind `version_unsupported` before anything
starts, and a bundled installation with `unsupported_installation`.
There is still no `opencodeRuntime.login`/`authStatus`.

**Options.** `timeoutMs` (default 30 s) is one budget for starting the
server until its integrations are loaded (every readiness read gets only
what is left of it), and the bound for each later request.
`loginTimeoutMs` (default 10 minutes) bounds how long a login waits for the
person; OpenCode 2.2.7's own attempts expire after 600 s, xAI's after
1800 s. `idleMs` (default 5 s) is how long the server stays up after the
last operation. `loopback` (default `"allow"`) is described under
[remote hosts](#signing-in-from-another-machine).

**Process.** The facade owns one `opencode serve --hostname 127.0.0.1 --port 0`,
started in the environment's home directory (where OpenCode's own background
service runs). Its environment is the caller's overlay with:

- a random password in `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD`,
  so none is printed; basic auth uses the fixed user `opencode` (2.2.7
  reads no username variable), and an inherited `OPENCODE_SERVER_USERNAME`
  (OpenCode 1's) is removed;
- `OPENCODE_DISABLE_AUTOUPDATE=1` and `OPENCODE_DISABLE_MODELS_FETCH=1`,
  both read by 2.2.7 (its update check and its model-catalog fetch); the
  registry still listed all 239 integrations with them set;
- on POSIX, `BROWSER=true`, a command that does nothing, so the server can
  never open a browser on the machine it runs on. Windows has no such
  command and keeps the caller's `BROWSER`. In a 2.2.7 run with `BROWSER`
  pointing at a recording script, connecting six browser methods called it
  zero times.

It waits for the `server listening on` line, then until both `/api/plugin`
and `/api/integration` are non-empty: on 2.2.7 the registry fills in stages
for about a second, and the plugin list appeared only once it was complete.
The facade reads the registry once at creation; `loginProviders()` serves
it. The server is shared by concurrent operations and stopped `idleMs` after
the last one ends, or at once by `close()`, which settles only once the
server has exited, an idle stop already under way included; the next
operation starts a new one. Its output is never forwarded. A 401 from the server (2.2.7:
`UnauthorizedError`, "Authentication required") rejects at once with kind
`authentication_failed`, never as a timeout.

The server runs under a small Node watchdog (the host's own
`process.execPath`, [`host-watchdog.ts`](../../packages/oar/src/shared/executable/host-watchdog.ts))
whose stdin is a pipe from OAR. When OAR's process dies in any way, SIGKILL
included, that pipe closes and the watchdog stops the server's process
group (SIGTERM, then SIGKILL; on Windows `taskkill /T /F` on its tree). A
host SIGKILLed right after creating the facade over 2.2.7 left no
`opencode serve` running three seconds later
([native check](../../experiments/opencode-provider-auth/native-checks.ts));
a [test](../../tests/opencode/provider-auth-host-death.test.ts) holds it on
the fake server, on Linux, macOS and Windows CI. On Windows OAR starts the
watchdog detached: otherwise Node's job object ends it together with the
host, and the server, started by a `.cmd` shim's own child, outlives both.
A compiled single executable host (Node SEA, Bun standalone) cannot run the
watchdog, because its `process.execPath` starts the application again; there
the server runs without one and stops with the host's own exit cleanup, but
outlives a SIGKILLed host.

**Side effects.** Like any `opencode serve` started in the user's home, it
loads and runs the user's global OpenCode configuration and plugins: it may
install plugins and start configured MCP servers. With the flags above it
does not fetch the model catalog or check for updates; it does not disable
plugins or configuration loading. After the idle shutdown every call starts
a new server first: creating the facade took 1.6 to 2.5 s and a call after
`close()` 1.4 s on 2.2.7 (Linux arm64, isolated HOME).

**Mapping.**

| Facade | OpenCode 2 |
| --- | --- |
| `loginProviders()` | `integration.list` at creation, in OpenCode's order. Each `oauth` method is `{ method: "oauth", name: label }` with no `subscription`: OpenCode does not say whether a sign-in is a subscription, and the contract leaves the field absent then. Then `key` as `api_key` named by its label or "`<name>` API key", then `env` as an ambient `api_key` named by its variables. `external` and `command` methods (Amazon Bedrock and Google Vertex profiles, Claude Agent) are omitted; an integration with nothing left is omitted (2.2.7: Claude Agent). |
| `listProviders()` | Integrations with a stored credential connection. Environment-only connections are not listed, as the contract says. `resolve` makes no difference: OpenCode's connections carry no secret and nothing is refreshed. |
| `status(id)` | `integration.get`: the first credential connection (OpenCode lists the newest first), else an environment connection. `label` is the credential's label or the variable's name; an `external` credential is configured with no `method`; no `subscription`. An id OpenCode does not know (404) is `{ providerId, configured: false }`, as with Pi. |
| `login(id, "oauth")` | Several OAuth methods: a `select` with their ids and labels. Then each required, visible form field that applies (`when`): `select` for options and booleans, `text` otherwise, an empty answer taking the field's default. 2.2.7's form schema has no secret field type (`string` with formats `email`, `uri`, `date`, `date-time`; `number`, `integer`, `boolean`, `multiselect`, `external`), so no field is asked as `secret`. Optional and hidden fields are left to OpenCode's defaults. `integration.oauth.connect`, then a `device_code` event when the instructions end in `enter code: X` (verification URI: the attempt's URL), else `auth_url` with the instructions. An attempt with `mode: "code"` or `paste` also gets a `manual_code` prompt, whose answer goes to `integration.oauth.complete`; the prompt's signal aborts when the attempt completes another way. `integration.oauth.status` is polled every second until `complete`. Then, when OpenCode lists a credential it did not list before, the integration's earlier credentials are removed with `credential.remove` (as for keys), and `status(id)` is returned; a failed removal still returns that status. |
| `login(id, "api_key")` | A `secret` prompt for the key, then the key method's form fields, then as `setApiKey`, returning `status(id)`. |
| `setApiKey(id, key)` | `integration.connect.key` (OpenCode stores without validating, adding a credential and making it active), then `credential.remove` for each credential the integration had before, so the new key replaces them. Once the key is stored it resolves even if a removal fails: the new key is active, and an earlier credential may remain. A refused key removes nothing. A key method whose form asks more (Azure, Cloudflare, Snowflake Cortex) is refused with `method_unavailable` naming `login(id, "api_key", interaction)`; an integration with no key prompt (GitHub Copilot) names its environment variables. |
| `logout(id)` | `credential.remove` for every credential connection; environment variables stay, so `status` may still read configured. |

**Ending a sign-in.** `failed` rejects with kind `rejected` and OpenCode's
message, `expired` with `expired`, the `loginTimeoutMs` deadline with
`timed_out`; aborting `interaction.signal` rejects with the signal's reason,
as Pi's facade does, even while a prompt is pending. A host whose `onEvent`
or `prompt` throws ends the sign-in with that error. Every unfinished
attempt is cancelled with `integration.oauth.cancel`. Keys and pasted codes
go only to OpenCode; OAR redacts them, and token shapes, from every error,
and results carry only connection metadata.

### Signing in from another machine

Browser methods return an authorize URL whose `redirect_uri` is a loopback
address on the machine running `opencode serve` (2.2.7: OpenAI's two
ChatGPT browser methods at `127.0.0.1:<port>` and `localhost:1455`, GitLab
at `127.0.0.1:8080`, Poe at `127.0.0.1:<port>`, DigitalOcean at
`localhost:1456`, Snowflake Cortex at `127.0.0.1:<port>`). Such a sign-in can
only finish in a browser on that machine, so it never completes from a
remote web UI. OpenCode's registry does not mark these methods, so OAR keeps
no list: with `loopback: "refuse"`, after `integration.oauth.connect` an
attempt that takes no pasted code (`mode` not `code`, no `paste`) and whose
URL has a `redirect_uri` or `redirect` query value with host `localhost`,
`127.0.0.1` or `::1` is cancelled before any URL is shown, and the login
rejects with kind `loopback_required`, naming that address and saying the
browser must run on that machine. Device methods (GitHub Copilot, xAI,
OpenAI's device code, the OpenCode console) and code or paste attempts are
unaffected. The detection covers only these URL shapes: a loopback callback
announced another way (another query name, another loopback address such as
`127.0.0.2`) is not recognized and is offered as usual.

**Caveats.** After two `setApiKey` calls for xAI the remaining credential
was labelled `xAI 2`: OpenCode made the default label unique while the
earlier credential still existed. The watchdog needs `process.execPath` to
be a Node executable that accepts `-e`.

**Evidence.** Observed on 2.2.7 (Linux arm64, 2026-11-11, isolated HOME,
synthetic keys): startup lines, readiness, the operations above, the 401
answer, the environment flags, key storage and removal, form errors, the
form schema in `/openapi.json`, the URL shapes and loopback refusal of the
browser methods, and the start and cancel of the GitHub Copilot, xAI,
OpenAI, Poe, DigitalOcean, GitLab and OpenCode console attempts
([probe and evidence](../../experiments/opencode-provider-auth/README.md)).
No sign-in was completed, so a completed attempt's stored connection
(whether it adds a credential or updates one), `mode: "code"`, `paste`, and
real `failed` and `expired` statuses are inferred from the OpenAPI schema
and bundled source and exercised only against the
[fake server](../../tests/fixtures/fake-opencode-serve.mjs)
([tests](../../tests/opencode/provider-auth.test.ts),
[OAuth tests](../../tests/opencode/provider-auth-oauth.test.ts)).

## Image-only input

OAR sends ACP image blocks without a text block when `input` is `""`.
OpenCode 1.18.35 delivers the image to a local scripted Anthropic provider
without an empty text block ([image-only provider test](../../sea-trial/vendor/image-only.vendor.test.ts)). The selected model must advertise
image input in `modalities.input`; a text-only model receives OpenCode's
"Cannot read" notice instead of the image. Its separate title-generation
request may add a title prompt beside the same image.

## Native concepts and calling interfaces

| Shape | Command | Protocol |
|---|---|---|
| HTTP server | `opencode serve` | REST + OpenAPI 3.1 self-description (`/doc`), SSE event stream |
| ACP server | `opencode acp` | Agent Client Protocol over stdio |
| Client | `opencode attach <url>` | Connects to someone else's server |
| One-shot | `opencode run` | Single turn |

The object hierarchy is `project` → `workspace` → `session`:

- `project` is a git worktree; its id is a hash (`/tmp/faye-oc/repo` →
  `5eb21528…`). **Every non-git directory collapses into one synthetic project
  `global`, with worktree recorded as `/`**, so on one machine all
  non-repository directories share one project.
- `workspace` (`wrk_` prefix) is a git worktree materialised under
  `~/.local/share/opencode/worktree/<projectID>/<slug>`.
- `session` (`ses_` prefix) carries three attribution columns: `project_id`,
  `workspace_id`, `parent_id`.

A session runs one agent loop at a time. A prompt is admitted as a user
message and the loop runs model steps until the last assistant message
finishes without tool calls; each step re-reads the messages, so a user
message admitted while the loop runs is part of the next step
(`session/prompt.ts` `runLoop`, [src]). A `task` subagent runs in a child
session (`parent_id`).

OAR uses `opencode acp`. It is opencode's own ACP layer, built as a client of
its own HTTP server API (`acp/service.ts` calls `sdk.session.prompt`,
`sdk.session.list` and so on, [src]), so the mapping onto ACP is upstream's.
`@opencode-ai/sdk` (1.18.34 on npm) is the generated client for that HTTP
API, and its `createOpencode()` starts `opencode serve` as a child process;
it is not an in-process SDK. The in-process host `@opencode-ai/sdk-next` is a
private workspace package and is not published. Driving the HTTP server
directly would mean a new adapter for an API in the middle of a v1 to v2
migration; it becomes worth it if child-session events or attaching to a
server the user already runs are needed.

## High-level mapping to OAR

OAR exposes one ordered record stream per Session
([contract](../../packages/oar/src/contracts/session.ts)). Every ACP frame is
recorded verbatim as a frame's `native`; the cross-runtime `events` are what
OAR reads out of it. Control calls are request/response record pairs.

| Native concept or owner | Current OAR mapping |
| --- | --- |
| `opencode acp` executable | One `opencode acp` subprocess per OAR Session, spawned in the session `cwd` with the env overlay (`null` removes an inherited variable, [contract](../spec/runtime-matrix.md#session-environment)); its exit is an `exited` response record (kill-runtime). |
| Persistent native session | `Session.id` is the native `ses_` id; `SessionOptions.resume` attaches through `session/resume`, which replays nothing (resume). |
| Handshake answers and opening pushes | Answers are frame records with `model` and `effort` events where they report them; no `authenticate` is sent. |
| Native agent and turn | Every `session/update` is one frame with `native` verbatim. No `spanId`. Attribution tier `opaque`: a `task` subagent's child session never reaches the transport, so only the parent's tool call shows (subagent). |
| Prompt, steer, queue and cancel | A turn is one `session/prompt` RPC, its answer carrying `turn_ended`. `steer()` is a second `session/prompt` while one runs; it joins the running loop and both answers close the one turn (steer). `queue()` is a host-memory FIFO; `abort()` is `session/cancel` with a kill fallback (abort). |
| Typed events, history and child graph | Events for message, reasoning, tool, usage and model updates; unknown kinds are recorded with no events. The graph is the root session only. |
| Client execution and interaction duties | opencode runs its own tools and asks for no terminal. A `session/request_permission` arrives only for what opencode's permission rules ask about; OAR allows it like every ACP request. The `question` tool is off for ACP clients ([src] `tool/registry.ts`). |

Sources: [OpenCode profile](../../packages/oar/src/runtimes/opencode/session.ts),
[ACP opening path](../../packages/oar/src/shared/acp/profile.ts),
[session controller](../../packages/oar/src/shared/acp/session.ts),
[turn machinery](../../packages/oar/src/shared/acp/turns.ts),
[event projection](../../packages/oar/src/shared/acp/projection.ts).

## Capability details

### Session creation and resume

`initialize` advertises `loadSession`, `sessionCapabilities` `close`, `fork`,
`list` and `resume`, and image prompts. The one auth method,
`opencode-login`, answers `{}` and changes nothing; credentials come from
`opencode auth login` or provider environment variables, and the `opencode/*`
free models need none. `session/new` answers the `model` and `mode` config
options, plus `effort` when the model has variants.

A resume naming another directory runs in the session's own: a session
created in A and resumed with `cwd` B printed A for `pwd`, transcript intact.
OAR reads the session's directory from `session/list` and refuses the resume
with `UnsupportedOptionError` on `cwd` ([resume in another
directory](resume-cwd.md)). Every non-git directory belongs to the one
`global` project, yet `session/list` without a directory still found a
session from a non-git directory when the resume named a git repository.

On both release lines a resume needs a matching list entry with a confirmed
saved cwd: missing list support, unlisted ids, a missing cwd and incomplete
listings produce `UnsupportedOptionError` on `cwd`, never
`SessionNotFoundError`. Listing authentication, process-exit and other RPC
failures keep their classification and prevent resume. After cwd
confirmation, a native resume error keeps its original classification; v1's
generic `-32603 OpenCode service failure` cannot prove absence
([missing targets](../spec/runtime-matrix.md#missing-resume-targets)).

### Interrupted input

On 1.18.35, steering followed immediately by `session/cancel` kept the
steering text in the next prompt's provider request. An aborted prompt does
not prove discard, so OAR emits no `input_dropped` for it. ACP provides no
verified input-ID echo; inputs still enter the view at their request.
[Native scripted-provider probe](../../experiments/input-interruption-2026-10-08.md).

### Prompt, steering, queueing, and abort

A `session/prompt` sent while one runs is not refused: opencode admits it and
the running loop reads it at its next step. Both prompt RPCs are answered
when the session goes idle, each after a `usage_update`
([src] `acp/service.ts` `runUntilIdle`). Live, a steer sent mid-turn landed
in the same turn's final reply (steer: "ALPHA BRAVO MANGO"). OAR therefore
gives the session a `steer` with no extra prompt parameters, and the turn
ends once, on the original prompt answer. Both native answers remain
recorded. If a steering RPC later refuses, its error frame reports
`input_dropped {inputId, reason: "runtime_refused"}`; the active turn keeps
its own outcome. Acceptance stays immediate rather than blocking until
OpenCode becomes idle.

`session/cancel` aborts the loop; the prompt answers `cancelled` about 0.1 s
later, the running shell call is closed, and the turn ends `aborted` (abort).
After an abort the `usage_update` reports `used: 0`, since it reads the
latest assistant message, which the abort left empty.

OAR owns the ACP process. An exit ending a running turn after its accepted
abort or dispose request is read as `aborted` by the folds; an unrequested
exit is `failed: runtime_exited`. A native turn end that arrives first keeps
its outcome, and the exit code stays on `exited`.
Disposal and the ten-second abort fallback end its
process group on POSIX (SIGTERM, then SIGKILL after the configured grace;
the SIGKILL, or the runtime's exit if that comes first, also takes its
descendants that left the group, as for
[claude](claude.md#process-ownership-environment-installation-and-account-usage)),
or its process tree on Windows (`taskkill /T /F`, including a launcher and
the runtime behind it). The [dispose regression](../../tests/session-dispose.test.ts)
checks both runtime and descendant termination. See
[host-exit cleanup and limits](../spec/record-stream.md#the-rules).

### Observation, children, and history

Text, reasoning (`agent_thought_chunk`), tool calls and `usage_update` arrive
as `session/update`. A tool call's opening `tool_call` carries its name as
`title` and no arguments: a shell call has `title` `bash`, `kind` `execute`
and `rawInput` `{cwd}` only, and the file tools (`write`, `read`, `edit`,
`grep`, `glob`) an empty `rawInput`. The arguments arrive on the next
`tool_call_update` (tool-detail): `bash` `{command, cwd}` or
`{command, workdir}`, retitled with the command; `read` `{filePath}`;
`write` `{content, filePath}`; `edit` `{filePath, oldString, newString}`;
`grep` and `glob` `{path, pattern}`. OAR reads that update as a
`tool_call_input` with the whole input (a further update repeating them
adds none), and the session view's tool part takes it, so
`classifyTool` reads `bash` as `run_command` with its `command`, `read` as
`read_file`, `write` and `edit` as `edit_file` and `grep` and `glob` as
`search`, each file tool with its `filePath` or `path` as the detail
(`read`, `write` and `edit` also give that one path as `paths`)
([recordings](../../tests/replay/fixtures/opencode-acp-v1-files.vendor.json),
[test](../../tests/replay/tool-activity.test.ts)). No recorded `bash` input
has a `description`. The closing update carries the output in `content` and
`rawOutput` `{metadata, output}`, and retitles the call (`write`, `read`
and `edit` with the file path, `grep` with the pattern, `glob` with the
directory).

The prompt answer's `usage` field is the last assistant message's tokens
only, not the turn's, so OAR does not report token totals (and so no
`cacheRead` or `cacheWrite`); context usage comes from `usage_update`
(`used`, `size`, `cost`).

A `task` subagent completed and its result reached the parent (subagent:
`CHILD-OK-7731`), but no frame of the child session arrived: opencode's ACP
layer forwards parts only for sessions it opened ([src] `acp/event.ts`).

### Service tiers

`SessionOptions.serviceTier` is explicitly refused with
`UnsupportedOptionError`, declared in `Runtime.refusedSessionOptions`.
No per-session native setting plus applied-state readback has been verified
for this adapter; `listModels` therefore advertises no service tiers. OAR
does not silently ignore a requested tier or alter a global default.

### Models, effort, instructions, and context

Model ids are `provider/model` (`opencode/big-pickle`). `session/set_model`
answers `{}` and 1.18.30 pushes nothing, although the switch applies, so OAR
switches with `session/set_config_option` on `model`, whose answer lists
every option with its current value. `listModels` reads
`opencode models --verbose` (every configured provider's models, with each
model's `variants`). On both lines the query runs in
`ListModelsOptions.cwd` (default: the host's cwd), because project
configuration there can add providers.

Effort is the `effort` option in the `thought_level` category, present only
for a model with variants; its values are the variant names
(`low`/`high`/`max` on `opencode/fledge-alpha-free`). Because the menu
belongs to the model, OAR reads it from the model switch's answer when a
model was requested; on a model without variants `effort` is refused with
`UnsupportedOptionError`. An unknown model fails the open with the agent's
`Invalid params: model not found` (bad-model).

ACP has no direct prompt field, but the native launcher reads
`OPENCODE_CONFIG_CONTENT`. OAR uses a fresh inline configuration for the
session: `systemPrompt` overrides only the selected `agent.<name>.prompt`;
`appendSystemPrompt` adds one session-owned file to `instructions`. Native
config merging appends that file **after existing instructions**, preserving
other agents, model choices, tools and permission rules. Environment/context,
project instructions and skills that OpenCode adds separately still apply.
The file stays available for later turns and compaction and is removed on
failed open, disposal or process exit. OAR does not rewrite user config or
redirect the runtime's native home.

Before a replacement, OAR runs the selected executable's read-only
`debug config` in the session directory, with the session environment. It
uses `default_agent` (otherwise the native `build` default). For resume,
`export <id> --sanitize` supplies the saved agent, including the historical
message fallback, before consulting that default. No transcript is logged
or used to rebuild the conversation. The ACP open must report that same
mode; otherwise opening fails and names both agents. This also protects
against disabled/renamed defaults and config changes between query and open.
A saved or configured default custom agent missing from resolved config is
refused before injection, so a prompt override cannot recreate a deleted agent
with default permissions. Only the visible built-ins `build` and `plan` may
be absent from that config.
A replacement adds one native startup query, two on resume, each bounded at
30 seconds; no prompt options retains the direct ACP path, and append-only
needs no agent query.

If the effective session environment defines `OPENCODE_CONFIG_CONTENT`,
either prompt option is refused with
`UnsupportedOptionError`. OAR does not parse or merge that existing value.
Setting `env: { OPENCODE_CONFIG_CONTENT: null }` removes an inherited value
before native configuration queries and permits prompt injection.
An empty replacement is also refused: native OpenCode treats an empty agent
prompt as selecting its built-in prompt. Literal `{env:...}` and
`{file:...}` in the supplied prompt are preserved, not expanded by the
native config parser.

[Native request probe](../../experiments/opencode-prompt-options.ts),
**1.18.34**, Linux x64, 2026-10-07: OAR and the real ACP process send requests
to a local scripted provider, without login or model quota. Assertions cover
custom default and customized build agents, both prompt options, earlier
instructions remaining first, resume after the default agent changes,
literal interpolation syntax, unchanged model and denied edit tools,
unchanged config bytes, temporary-file removal, refusal to recreate a deleted agent, and config-env conflicts.
The fixture config includes its `$schema` because OpenCode itself may add
that field to a schema-less file even on the baseline path (observed in an
isolated probe).

Source at [v1.18.34](https://github.com/anomalyco/opencode/tree/v1.18.34):
`config/config.ts` merges inline content and concatenates instructions;
`config/variable.ts` substitutes variables before JSON parsing;
`agent/agent.ts` resolves the default; `acp/service.ts` restores saved agent
selection; `session/llm/request.ts` chooses the agent prompt; and
`session/instruction.ts` reads instruction files again for subsequent requests.

| Session option | Native channel and result |
| --- | --- |
| `cwd` | ACP directory; a resume elsewhere is refused from native `session/list`. |
| `resume` | ACP resume, native session identity and saved agent. |
| `model` | ACP model config option with native read-back. |
| `effort` | ACP `thought_level` config option when the selected model has variants; otherwise refused. |
| `systemPrompt` | Fresh inline `agent.<selected>.prompt`, verified against the ACP mode on new/resumed sessions. |
| `appendSystemPrompt` | Fresh inline `instructions` entry for a session-owned temporary file, on new/resumed sessions. The file goes when the session ends; a host that ends without disposing leaves it to its `exit` event or the next opencode session's sweep ([private-temp](../../packages/oar/src/shared/private-temp.ts)). |
| `env` | Child-process environment, shared by native queries, the ACP process and its tools. |
| `name` | Refused with `UnsupportedOptionError` on both lines (no verified session name setting), declared in `Runtime.refusedSessionOptions` ([session name](../spec/runtime-matrix.md#session-name)). |

### Tools, permissions, and process

opencode runs its own tools in its own process tree and asks the client for
no terminal and no file access. It inherits the session's environment, so a
crew child's environment reaches its tools. Installation is the `opencode`
executable on PATH (npm `opencode-ai`, Homebrew, Scoop) or the install
script's `~/.opencode/bin/opencode`, pinned with `OAR_OPENCODE_BIN`.

OpenCode ships two major lines of that one command: OpenCode 1 (npm
`opencode-ai`, 1.x; `--version` prints `1.18.35`) and OpenCode 2 (npm
`@opencode/cli`, 2.x; `opencode v2.0.26`). They do not install side by side:
both scripts write `~/.opencode/bin/opencode`, the 2 installer replaces a 1
binary ([migrating from 1](https://opencode.ai/v2/docs/migrate-v1)) and the 1
script silently replaces a 2 binary
([anomalyco/opencode#54084](https://github.com/anomalyco/opencode/issues/54084)).
So the runtime declares `installLines` `v1` and `v2`, and
[`install`](../../packages/oar/src/runtimes/opencode/install.ts) takes the
host's `line` (none is `line_required`: OAR does not choose) and runs that
line's script when nothing is found: `curl -fsSL https://opencode.ai/install | bash`
([docs](https://opencode.ai/docs/#install)) or
`curl -fsSL https://opencode.ai/v2/install | bash`
([v2 docs](https://opencode.ai/v2/docs/)), macOS and Linux. A copy of either
line already found is `already_installed` with its `line`, never replaced.
OAR uses those scripts because each line's `opencode upgrade` takes its
script install as the `curl` method and stays on the line
([runtime install](../spec/install.md), [sandbox run](install.md)).

### Session MCP servers

This section's measurements are v1 unless they name 2.x. v2's Code Mode
`execute` and its open cold-resume race are in the [v2 MCP notes](#v2-session-behavior).

`SessionOptions.mcpServers` is ACP's `mcpServers` on `session/new`,
`session/load` and `session/resume`, in ACP's `McpServer` shape (stdio
`{name, command, args, env}`, http `{type: "http", name, url, headers}`,
`env` and `headers` as `{name, value}` lists; `args`, `env` and `headers`
always sent, empty when absent;
[mapping](../../packages/oar/src/shared/acp/mcp-servers.ts),
[test](../../tests/acp/acp-session-mcp-servers.test.ts)). opencode declares
`mcpCapabilities` http and sse, so http entries are sent (to an agent that
declares no http, OAR refuses one with `UnsupportedOptionError`). An empty
or repeated name fails the open before opencode starts; a reserved name such
as `__proto__` (which opencode would drop) fails it with
`UnsupportedOptionError` ([reserved names](../spec/runtime-matrix.md#refused-session-options)).
Measured on opencode 1.18.30 against a scripted provider: an isolated `HOME`
and XDG dirs, provider `aimock` on opencode's bundled `@ai-sdk/anthropic` in
`$XDG_CONFIG_HOME/opencode/opencode.json`
([vendor test](../../sea-trial/vendor/mcp-servers-acp.vendor.test.ts),
[harness](../../sea-trial/harness/aimock-acp.ts)):

- Both transports attach and the model is offered each tool as
  `<server>_<tool>` (`echo_echo`, `remote_echo`), which is also the ACP
  `tool_call` title. The tool result reached the provider as the server
  wrote it, so the server ran with the entry's `env` (stdio) or `headers`
  (http).
- [src] at v1.18.30, `acp/service.ts` hands every entry on new, load, resume
  and fork to `sdk.mcp.add({directory, name, config})`: stdio becomes
  `{type: "local", command: [command, ...args], environment}`, http
  `{type: "remote", url, headers}` (streamable HTTP, then SSE). Errors are
  ignored, so a server that fails to attach fails silently. The servers are
  held in memory by that opencode process, which OAR starts once per session.
- A resume remembers none: resumed with the option, the servers attach
  again; resumed without it, neither tool is offered.
- On a name clash the session's `echo` replaces the user's `mcp.echo` for
  that process, and the user's `userecho` is still called (answering with
  the user's credential). Probed, not in
  the test: a session `echo` whose command is broken still opens, and removes
  the user's working `echo` too (opencode closes and deletes the same-name
  client on failure).
- With `systemPrompt` or `appendSystemPrompt` the session opens through the
  prompt path ([prompts](#models-effort-instructions-and-context)): the
  prompts travel in `OPENCODE_CONFIG_CONTENT` and the servers in the same
  ACP open as above. Measured with both prompts and both servers in one
  session: every agent request carried both prompts and both echoes arrived
  ([vendor test](../../sea-trial/vendor/mcp-servers-acp.vendor.test.ts);
  the open's wiring in
  [prompt-cleanup](../../tests/opencode/prompt-cleanup.test.ts)).

The credentials reach opencode only in the open request's params, which OAR
does not record (it records the answers and every `session/update`). A probe
found none in any ACP answer, notification or stderr line, nor under
opencode's directories; the vendor test asserts no record holds one. A failed
open's error message and stack are redacted (`[redacted]`).

A server's tool-list change reaches the running session in full on both
lines (`Runtime.mcpToolsListChanged` `"full"`). On 2.x a system update adds
the new tools and withdraws the removed ones, and a call to a removed tool
fails locally without reaching the server
([probe](../../experiments/mcp-tools-catalog-changed.ts); 2.0.30,
[October 16 report](../../experiments/runtime-version-checks/2026-10-16.md);
2.0.32, [October 17 report](../../experiments/runtime-version-checks/2026-10-17.md)).
See [host-served tools](../spec/runtime-matrix.md#host-served-tools).

## Verification and open gaps

- Only free `opencode/*` models were run; a logged-in provider and its
  permission prompts were not.
- Steer timing against a long tool call was not measured: the steer joins at
  the next model step, so it waits for a running tool to finish.
- The HTTP server would carry child sessions and a replayable event cursor;
  not integrated.
- No update check or upgrade (`opencode upgrade` exists; OAR does not drive
  it) and no account usage query.
- [Session MCP servers](#session-mcp-servers) ran against a scripted
  provider only, not a logged-in provider or a free `opencode/*` model. The
  vendor test and shared behavior suite run in CI (`OAR_TEST=opencode-aimock`),
  pinned to `opencode-ai@1.19.5` on Linux and macOS. Windows runs the same
  suites after main pushes in a separate
  [observation workflow](../../.github/workflows/acp-windows.yml), outside
  PR gates because intermittent startup or MCP timeouts remain unexplained.
  [Scope and evidence](../../experiments/acp-ci-2026-10-29.md).
  The broken-command clash was probed, not tested.
- The full `opencode-aimock` vendor suite is v1 only: on v2 **2.2.7**,
  11 of its 16 cases passed and 5 failed in the November 10 Linux check.
  The five failures need v1 protocol (direct MCP tools in the
  provider's `tools` array, a classification from that array, or v1 prompt
  replacement)
  ([November 10 report](../../experiments/runtime-version-checks/2026-11-10.md#known-v1-vendor-boundary)).
  v2 evidence is the boundary probe, the shared behavior suite and focused probes.
- Unexplained first-run failures, not reproduced on rerun:
  `opencode --version` over its 15-second limit during concurrent opens
  (1.19.2, [October 16 report](../../experiments/runtime-version-checks/2026-10-16.md));
  two opens per line exiting with code 1 (1.19.3, 2.0.32), and a 2.0.32
  model query failing natively with
  `ServiceUnavailableError: Location plugins did not finish activating`
  ([October 17 report](../../experiments/runtime-version-checks/2026-10-17.md)).

## The HTTP server, investigated 2026-09-12

Evidence baseline for this section: opencode 1.18.30 (`~/.opencode/bin/opencode`),
Linux x86_64, probed 2026-09-12 through headless
`opencode serve --port 4610/4611/4612`. The machine-readable contract is
`GET /doc` (OpenAPI 3.1, 162 paths); every conclusion was cross-checked against
the rows in `~/.local/share/opencode/opencode.db`.

### Storage: event sourcing and mutable projections in one database

One SQLite file, `~/.local/share/opencode/opencode.db`, holds 20 tables:
`account`, `account_state`, `control_account`, `credential`, `data_migration`,
`event`, `event_sequence`, `message`, `migration`, `part`, `permission`,
`project`, `project_directory`, `session`, `session_context_epoch`,
`session_input`, `session_message`, `session_share`, `todo`, `workspace`.

The structure that matters: `event` (an immutable stream keyed by
`aggregate_id` + `seq`) plus `event_sequence` (a per-aggregate cursor carrying
an explicit **`owner_id`** column) plus mutable projection tables (`session`,
`message`, `part`, …). The projection can be rewritten while the events stay
fixed.

### Events and projections disagree, and it is the projection that moves

A session created through the `global` project's server, with
`directory=/tmp/faye-oc/repo`, still carries `"projectID": "global"` in its
immutable seq-0 event. After another server claimed that directory as a git
project, the `session` **row** was retroactively rewritten to `5eb21528…`.
The projection alone says the session always belonged to that project; the
log alone says it never moved.

### Event model: two naming layers, only the persistent one is versioned

- **Bus / HTTP layer: roughly 60 event names, none versioned.** Examples:
  `agent.cycle`, `catalog.updated`, `permission.asked`, `permission.replied`,
  `question.asked`, `pty.created/deleted/exited/updated`, `mcp.tools.changed`,
  `plugin.added`, `session.idle`, `session.error`, `message.part.delta`,
  `session.next.compaction.delta`, `session.next.reasoning.delta`,
  `server.connected`, `global.disposed`, `project.directories.updated`.
- **Persistence / sync layer: 35 types, all suffixed `.N`.** 33 are at `.1`;
  only `session.next.step.ended.2` and `session.next.step.failed.2` are at
  `.2`.

Of the four harnesses surveyed, opencode alone versions events explicitly.

`/sync/history` cursor semantics: the request body is
`{<aggregateID>: <last seen seq>}` and the response returns events **strictly
greater than** that seq for the named aggregate; **any aggregate not listed is
returned in full from seq 0.** Posting `{"ses_f6ba40976f…":1}` returned only
seq 2 and 3 for that session while five other aggregates came back whole,
consistent with the documented behaviour.

### `/sync/steal` is workspace re-homing, not control preemption

```
POST /sync/steal?workspace=wrk_09460c96a0019dGVNJB3IhqUWP
     {"sessionID":"ses_f6ba40976ffeOGfLJoyWTDRJd4"}
→   {"sessionID":"ses_f6ba40976ffeOGfLJoyWTDRJd4"}
```

The query parameter names the target, the body names the session; omitting
`?workspace=` or passing it empty is a `{"_tag":"BadRequest"}`. Database state
before and after:

| | before | after |
|---|---|---|
| `session.workspace_id` | empty | `wrk_0946…` |
| `event_sequence.owner_id` | empty | `wrk_0946…` |
| appended `event` | none | one `session.updated.1` per call |

It emits `session.updated.1`, **not** `session.next.moved.1`; do not conflate
the two. It is **idempotent in state but not in events**: repeated calls leave
the state unchanged while the event stream keeps growing.

**"Current workspace" is declared per request by the client, not held as
server state.** The same steal succeeded from a server started at the
repository root (4611) and from one started inside the worktree (4612); the
server's cwd does not participate.

### `/sync/replay` rebuilds a session from its events, and identity is client-declared

1. Replaying a session's own 4 events verbatim (with `?workspace=`) returns
   **the same** sessionID, which alone cannot distinguish rebuild from no-op.
2. After `DELETE /session/<id>` (session row and event rows both go to zero),
   replaying its seq-0 event **fully rebuilds** the session: id, slug and
   directory all return. Replay is recovery from the log.
3. Rewriting `aggregateID` / `sessionID` / the event `id` in the payload to a
   fresh `ses_` returns the new id and produces **an entirely new session**:
   same slug, same directory, a clone.
4. Posting the same payload twice leaves a single seq-0 row: **event-level
   idempotent** (the opposite of `steal`).

So on `/sync/replay` **the client supplies the restored sessionID inside the
event**; this does not establish how normal session creation mints IDs.
`?workspace=` only sets `event_sequence.owner_id`; the session row's
`workspace_id` / `project_id` / `directory` are restored from the event
payload, never from the query parameter. Moving a session to another machine
or workspace is therefore protocol-feasible, at the cost of session identity
having no server-side authority: whoever can write events can declare
identity. On this machine the server ran unauthenticated by default
(`OPENCODE_SERVER_PASSWORD` unset).

Two API traps: `/sync/history` returns `aggregate_id` (snake_case) while
`/sync/replay` requires `aggregateID` (camelCase), so a round-trip must rename
the field; and a replay missing `?workspace=` reports `500 UnknownError` with an
`err_<id>` reference rather than `400`.

### Where `parent_id` comes from

- **Only** `POST /session {"parentID":"ses_…"}` writes `parent_id`; it appears
  in `/children` immediately.
- **Fork does not write `parent_id`**: after a fork, `/children` returns `[]`,
  while `/children`'s own documentation describes "child sessions that were
  **forked** from the specified parent". Documentation and implementation
  disagree.
- `POST /api/session` is a second session-creation endpoint whose schema has no
  `parentID`. Passing it neither errors nor takes effect, despite the schema
  declaring `additionalProperties: false`: unknown fields are silently
  swallowed.
- Related schema surface: `subagent`, `subagent_depth`,
  `/experimental/session/{id}/background`.

### Attribution compared with the other samples

- **Claude Code**: runtime process identity `(pidDomain, pid, procStart)` plus a
  peer socket registry. Attribution is bound to a **living process**.
- **Codex**: `installation_id` plus `[projects."<absolute path>"].trust_level`.
  Attribution is bound to a **disk path**.
- **opencode**: workspace scope, rewritable by events, with a literal `owner_id`
  column on the event stream. Attribution is **first-class, movable data**.

### Addressability, resumability floor, and resume material

In the vocabulary shared across the samples:

| Property | opencode |
|---|---|
| identity authority | client-declared on `/sync/replay`; normal creation authority not established by this probe |
| uniqueness scope | globally unique only if clients do not collide; `event_sequence.owner_id` is workspace scoped |
| connection identity, by on-wire addressability | none; HTTP and SSE carry no connection id, and even "current workspace" is declared per request via `?workspace=` |
| resumability floor | event-stream seq 0; deleting the session and replaying its seq-0 event rebuilds id, slug and directory in full |
| history paging cursor | `/sync/history` with a per-aggregate last-seen seq |
| live stream resume cursor | none on the bus itself; the difference can be filled in afterwards from `/sync/history` |
| runtime side resume material | the immutable `event` table |
| broadcast and subscription separated | separated by versioning, not by tier: the transient bus is unversioned, the 35 persistent sync types are all `.N` |
| death boundary | not observed |

"Runtime side resume material" is material the runtime feeds back to the
model; replay is what a host offers its own subscribers. The two words should
not be mixed.

### Design input for OAR

- **A log and a projection are two truths, and reading one is not reading the
  other.** Any host that consumes a runtime's stored state has to say which of
  the two it read.
- **Identity written by the client has no server authority** (`/sync/replay`
  above), so a host cannot inherit the runtime's identity as its own: OAR's
  lineage has to record the requests OAR itself issued.
- **Versioning only the persistent layer is a deliberate, copyable split.**
  Transient broadcast (~60 unversioned bus names) and replayable record (35
  `.N` types) are different contracts, and only the second needs to promise
  evolution.

### Server investigation gaps

- **Blocked, not explained.** `POST /experimental/workspace {"type":"worktree"}`
  returns `{"name":"WorkspaceCreateError","data":{"message":"Timed out waiting
  for global event"}}` **while the database row and the on-disk git worktree are
  both created**: a post-creation wait timeout (most likely on a server
  instance or sync loop inside the new worktree), not a creation failure.
  `GET /experimental/workspace` and `/experimental/workspace/status` still
  return `[]` when the row exists. It is not localised further: the server
  log printed only the unset-password warning, and the `err_<id>` detail
  never reaches stdout.
- Calling create twice leaves **two workspace rows pointing at the same
  directory**. `DELETE /experimental/workspace/{id}` removes the database row,
  the on-disk git worktree and the git registration, but **leaves the
  `project_directory` row pointing at the missing directory**, another
  projection that did not keep up.
- Not probed: `/api/session/{id}/event`, `/event`,
  `/experimental/session/{id}/background`, `/api/pty/*`, `/mcp/*`,
  `/permission`, `project.sandboxes`, `session_context_epoch`.
- No real model turns ran, so message/part write granularity is unmeasured.
- Death boundary not observed: no process was killed mid-turn, so the event
  stream and projections at an abrupt exit are unknown.

## Disallowed tools

`SessionOptions.disallowedTools` is refused before prompt preparation or
launch and declared in `refusedSessionOptions`. OpenCode 1.18.35 has native
global and per-agent permission rules, but a global deny can be overridden
by an agent's allow. Permission names also differ from tool names (for
example, multiple file mutations share `edit`). ACP exposes no session
native tool-name denylist. OAR does not rewrite the user's agent definition
or turn a denylist into a computed allowlist.

Evidence and verification limits: [tool-denial audit](../../experiments/disallowed-tools-2026-10-08.md).

## Launch arguments

`SessionOptions.launchArgs` go after `acp`, on the process the session runs; OAR's helper queries (`--version`, `models`, and the prompt path's `debug config` and `export`) do not get them. OAR passes them unchecked and never records them; give them again on resume. See [launch arguments](../spec/runtime-matrix.md#launch-arguments).

## Additional directories

`SessionOptions.additionalDirectories` is supported on **v2** through the
native ACP field on `session/new` and `session/resume`, after initialize
advertises `sessionCapabilities.additionalDirectories`. Paths resolve
against cwd. On 2.0.26 and 2.0.27
([October 12 evidence](../../experiments/runtime-version-checks/2026-10-12.md)),
`session/list` reported the supplied roots on new and resumed sessions (a
resume's list replaces the earlier one), and a cold resume with the field
omitted lost them. Supply the list again on resume. Empty has the same OAR
meaning as omission.

**v1 refuses** a non-empty list before prompt preparation or ACP opening;
1.18.35 has no advertised/effective native directory channel. Permission
rules for `external_directory` are a different setting and are not used as
a substitute. cwd remains primary on both lines.

[Evidence and verification limits](../../experiments/additional-directories-2026-10-11.md).

## Structured output

`SessionOptions.outputSchema` is declared refused on both release lines and
fails before launch. OpenCode has a JSON-schema format on its HTTP prompt
API, but its ACP prompt path does not forward that setting, and no ACP
launch/configuration equivalent was verified. OAR uses ACP and does not
silently switch interfaces or replace the schema with prompt instructions.

[Native channel audit](../../experiments/structured-output-2026-10-11.md).

## User configuration

`userConfiguration: "exclude"` is declared refused with
`UnsupportedOptionError` before opening a session. This adapter has no
verified separation of user configuration from native login and session
history. Omission and `"include"` retain existing behavior. See the
[shared contract](../spec/runtime-matrix.md#user-configuration).

## Orientation query costs

`listModels()` starts `opencode models --verbose` on v1 or
`opencode models --standalone` on v2 in the selected workspace. Native project
configuration, provider credentials and catalog cache affect the result; a cold
catalog can involve network access. It does not submit a model turn. OAR exposes
no auth-status reader for local orientation.

## Reader environment

Installation and model listing accept the session-style `env` overlay.
The model reader uses it both when identifying an unknown native version and
when querying that version's catalog. See
[reader environments](../spec/orientation.md#environment).
