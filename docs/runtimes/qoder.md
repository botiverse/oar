# Qoder

OAR uses Qoder's native bidirectional JSON-line SDK protocol, with one
owned process per open session. From 1.1.81, OAR uses `--sdk` and the official
SDK's daemon protocol (verified 2026-10-29,
[evidence and reproduction](../../experiments/qoder-native/daemon-2026-10-29.md)).
Qoder 1.1.78 through 1.1.80 use the worker interface: `--print --input-format
stream-json --output-format stream-json` and the native stdio permission flag
(probed on 1.1.78, Linux, 2026-10-23). The last worker release, **1.1.80**,
passed eight native cases, 17 shared behavior cases (two skipped) and eight
native priority controls on 2026-10-28 with separate settings files, using no
real account or paid provider
([report](../../experiments/runtime-version-checks/2026-10-28.md#qoder-1180)).
The [model-selection probe](../../experiments/qoder-native/model-selection-report.md)
uses an existing login for catalog reads and opens, without a model prompt.

Latest check, **1.1.89** (Linux x64, 2026-11-13): cache and live catalogs and
init confirm the selected `efficient` model through the ModelProvider mapping
([PR #624](https://github.com/botiverse/oar/pull/624)), and OAR opens. The
permission replay still returns HTTP 500 before any permission request and
the full replay suite fails, so CI stays on 1.1.81
([latest check](../../experiments/runtime-version-checks/2026-11-13.md#qoder-1189);
see [Evidence and limits](#evidence-and-limits)).

## Manual compaction

`compact()` is idle-only and sends the native built-in `/compact` with the OAR
request id as its command UUID; Qoder 1.1.81 intercepts this built-in before
custom commands. Results carry no input UUID, so an ordinary successful result
cannot prove compaction. OAR requires the command's started lifecycle, a root
manual `compact_boundary`, and its completed or cancelled lifecycle:

- Boundary seen: `completed`, even if cancellation arrives later. The ordinary
  result remains its own native fact (success in the measured race).
- Cancelled without a boundary: `aborted`. A native error result:
  `failed / native_failed`.
- Otherwise, including empty history: `failed / not_compacted`.

`queue()` is retained until the command settles. The compact request carries
`settledBy: "native_response"`; exact `command_uuid` equality attaches
`responseTo` to its terminal lifecycle, and that frame releases the input gate
and compacting status together, even without an ordinary result. Earlier turn
and compaction events stay in place and do not release the operation. Native
`system/status compacting` projects the start without an inferred trigger.
[Controls and evidence](../../experiments/manual-compaction-followup-2026-11-02.md).

## Transport versions

[src] Qoder 1.1.81 explicitly rejects the old SDK worker with
`sdk_worker_removed`. Removing `--permission-prompt-tool stdio` from ordinary
headless stream-json is insufficient: that path accepts user input but no
longer processes the SDK's `initialize` control. This is an intentional
transport removal. On 2026-10-29, the published official
`@qoder-ai/qoder-agent-sdk` 1.0.56 still bundled CLI 1.1.78 and its default
process transport still used the old flags; its public `startDaemon()` already
used `--sdk`. OAR follows that public entry point and protocol, without adding
a runtime dependency on the SDK.

The new owned process receives `daemon.initialize` with protocol version 2,
then `daemon.open_session` with the original worker arguments and cwd. OAR
requires `multi_session_v2` and `daemon_queries_v1`; an incompatible handshake
refuses opening and closes the process. Session messages and permission replies
carry their native `session_id`. Model reads move to `daemon.get_models`, an
account-level query without a session id, with the same catalog payload. Its
private replies, including late duplicates, remain outside public records.
If installation metadata omits the version, launch reads `--version` once in
the session environment. That one stable-version decision selects both the
transport (daemon from 1.1.81) and the model-catalog format (ModelProvider from
1.1.82); confirmation and listing do not probe or guess a version separately.
An unreadable or non-stable version refuses opening as a version compatibility
error instead of guessing a permission transport.

The daemon uses the child environment's personal access token or service-account
key when supplied, otherwise the native local `qodercli` login. A service-account
key combined with another explicit credential is refused, as in the native CLI.
A job token without a personal access token is refused: the official daemon
requires a host callback for that auth mode, which OAR does not implement.
Authentication travels only in the private handshake, never argv or records.

The native permission regression explicitly switches a replay session to the
native default permission mode to trigger `can_use_tool`, proves the tool has
not run before the response, and uses the production stdio response policy to
allow it. Normal OAR sessions retain `bypass_permissions`. The synthetic login
fixture depends on the native credential storage format; a format change must
fail native CI explicitly rather than silently substituting a real login.
Unknown daemon frames without a session id remain verbatim in records. A frame
for another session stops the owned daemon with an explanatory `exited.reason`;
its foreign content is not attributed to the current conversation.

## Shared-process admission boundary

OAR owns one daemon per session; shared placement requires the full
[design evidence gate](../design/system.md#shared-runtime-processes).
[env] One native 1.1.81 daemon ran two sessions concurrently on Linux; closing
one left the other able to complete another turn. This is only a routing and
basic close observation.

On Linux x64, native 1.1.81 sessions sharing a daemon and directory with the
same MCP server name but different arguments cross configurations: after B
opens, A's later and concurrent calls invoke B's server. Separate daemons with
the same directory preserve the two configurations. In a separate close
control, closing A/B and opening with an empty MCP list did not invoke a
retained tool. No native source for the exact sharing/retention scope has been
established; this is an observation, not a claim about how Qoder implements
its cache.

A future shared adapter must allow one session per canonical directory for
the entire process lifetime. A used directory remains unavailable after
release: another open uses a fresh isolated process for `auto` and refuses
explicit `shared` with `UnsupportedOptionError("placement")`, regardless of
whether the MCP list is identical or empty. The close result does not relax
this conservative rule. Configuration freshness and the three-platform
same-directory controls remain part of admission. Reproduce with
`pnpm tsx experiments/sharing/same-directory.ts qoder` and 1.1.81;
[report](../../experiments/sharing/same-directory-2026-10-30.md).

## Native interface

`initialize` establishes the control channel. User messages carry a UUID;
`command_lifecycle` reports queued, started, completed or cancelled inputs.
`system/init` can arrive while idle and is not evidence that a turn began.
The final `result` carries the turn outcome. Native cancellation before an
input starts can produce only `command_lifecycle cancelled`, without a result.

Partial content can omit `message_start` and the API message id. A later full
assistant message repeats the streamed text. OAR preserves every original
frame while projecting that text once. Parent tool ids attribute child-agent
frames when present; no separate child-session control is exposed.

`get_settings` reports `applied.effort`, and `get_models` supplies native model
selectors, resolved names, display names, default selection, effort levels and disabled entries.
These queries do not require a prompt. Configuration and account responses
are private: OAR exposes only the applied readback and model fields, never
identity, organization data or authentication material.

## OAR mapping

| Surface | Mapping and boundary |
| --- | --- |
| Session | Native session UUID; `--resume` opens its saved conversation. A missing id is refused, without creating a replacement. |
| Model and effort | `--model` accepts the catalog's `value` (`ModelEntry.id`), confirmed against init in the same process's catalog ([version-dependent rules](#model-confirmation)). The verified name is `resolvedId` when different from `id`; `model()` retains init verbatim. `--reasoning-effort` is confirmed by applied settings. A startup failure includes the requested effort as context, without claiming it caused the failure; a later model-confirmation error keeps its model-specific reason. Failure to confirm an explicit choice refuses opening. |
| Prompt and abort | Correlated native controls and lifecycle evidence. A cancelled unstarted input becomes `input_dropped`; input-scoped waits resolve it without inventing `turn_ended`. |
| Queue and withdrawal | OAR holds queued input until the current turn ends, so withdrawal remains possible. This queue is not durable across process loss. |
| Steer | A user message with native `priority: next` inserts at a tool boundary or starts after a text-only turn. The user echo preserves `inputId`; acceptance only confirms the write. Native `now` aborts the active turn and is not used for steering. [Priority evidence](../../experiments/qoder-native/README.md#input-priority-2026-10-24). |
| MCP | Native stdio and HTTP servers through a private per-process configuration file. Credentials are omitted from argv and redacted from public records. |
| System and tools | Native system/append prompt files, additional-directory and disallowed-tool startup flags. Native global configuration still applies. |
| Unsupported options | `goals: true`, `endTurnProcessesOnAbort: true`, `serviceTier`, `outputSchema`, persisted session `name` and `userConfiguration: "exclude"` ([below](#user-configuration-selection)) are explicitly refused. Image input is refused. `launchArgs` cannot override OAR-owned protocol, session, permission, effort, name or replay flags. |
| Cleanup | EOF permits normal idle shutdown; active disposal and bounded shutdown use process-tree cleanup. Native exit is recorded. |

System prompts use `--system-prompt-file` and `--append-system-prompt-file`.
OAR writes each as a 0600 file in the same 0700 temporary directory as any MCP
configuration, and removes the directory on process exit or failed launch.
Prompt contents never enter argv, including empty and multiline prompts.

Qoder 1.1.78 applies new replacement and appended prompts on resume. The native
regression seeds a saved conversation, then reopens it separately with each
new prompt, longer than the Windows command-line limit. An intentionally
exhausted native replay retains its actual model input in the conversation's
error details: that input contains the new prompt and neither old prompt.
This checks request construction, not a successful remote-provider answer.

### Steering and delivery

OAR enables `--replay-user-messages` so native user echoes retain the submitted
UUID as `user_message.inputId`. In the Linux 1.1.78 replay controls, a steer
while an MCP handler was blocked joined that same query after the tool result;
a steer during a text-only response became a second query after the first
completed. Both paths ended successfully through the public OAR interface.
The request-capture controls also confirmed the injected text in the next
model request. This verifies the native loop with a local response reader,
not a successful remote-provider call. The same two OAR steering cases passed
on [Windows](https://github.com/botiverse/oar/actions/runs/40053017848/job/120749644261)
and [macOS](https://github.com/botiverse/oar/actions/runs/40053017848/job/120749644019)
at `b239c35`, alongside all six existing native Qoder cases and the shared
behavior suite. An [earlier Windows run](https://github.com/botiverse/oar/actions/runs/40050232565/job/120741056271)
passed both steering cases but failed an older effort test after native
completion and exit, while fixture cleanup still counted against the
whole-test deadline (its exact remaining cost was not measured); cleanup now
uses the separate bounded hook described [below](#concurrent-startup-observations).

The steer's accepted response means the input was written, not consumed.
The user echo confirms the runtime observed that input. Since steer writes do
not project `input_queued`, an input-scoped `awaitTurnEnd` starting at the control request
can return the original turn's end before the steer is echoed. To observe the
turn that includes the steer, first observe its matching `user_message`, then
wait for the end after that record's sequence. Echo identity is native evidence;
OAR does not create an extra turn for an input absorbed by the current query.

### Usage and failures

Qoder 1.1.78 hides token counts by default: even a local provider response with
nonzero counts becomes zeros on the output wire. OAR sets the native
`QODER_EXPOSE_TOKEN_USAGE=1` switch only on its own child process. A direct
comparison produced 100 input / 10 output and then 200 / 20 with the switch,
versus zero for both queries without it.

Native `result.usage` is per query, not cumulative across the conversation.
OAR sums reports from this open only. After reopening a saved session, old
usage is not added again. Cache read and write follow the native usage fields;
the successful local probe reported zero cache counts. No account spend or
context fullness is inferred from token totals.

The two real-account requests attempted during validation were rejected with
native error code 118 and exhausted personal Credits. OAR classifies that
result as `billing`, retaining the exact native reason. Their raw zero counts
are preserved in the fixtures, but the default wire format does not establish
that the requests incurred no usage. No further real model requests were made.

## Installation and login

`login` and `authStatus` accept the same `env` overlay as sessions, including
the status query after login and executable lookup. Strings set variables;
`null` removes them. The per-login browser suppression override takes
precedence over caller `BROWSER`. OAR leaves the host environment unchanged.
See [environment capture](../spec/login.md#environment).

OAR finds `OAR_QODER_BIN`, `qodercli` on PATH, or the official user installation
under `~/.local/bin`. On Unix, `installPlan` describes the vendor's installer
with `--skip-path`; `install` verifies the resulting executable. Windows
installation is left to the vendor instructions. The native executable can
materialize its own files under `~/.qoder` during startup, including `--version`.
Installation discovery runs only `--version`, avoiding the heavier `--help`
query. In three isolated Linux homes, cold version queries took 0.490 to
0.909 seconds, while help took 1.375 to 1.773 seconds. These are observations,
not latency guarantees; both commands materialized native files. A probe can
still exceed its 15-second deadline under load. That rejects with a probe
error retaining the timeout and stderr, rather than returning `not_found`.
Only a missing executable produces `not_found`. The comparison is repeatable
with `pnpm tsx experiments/qoder-native/installation.ts`.

`login()` drives `qodercli login` and forwards only the standalone authorization
URL. Cancellation and deadlines stop that attempt without logging out an
existing account. `openBrowser: false` sets `BROWSER=www-browser` for this
child, which Qoder's native browser predicate treats as unavailable.
`NO_BROWSER` did not suppress the browser in the tested version.

There is no `logout()`. Qoder 1.1.87 signs out only through the interactive
`/logout` (alias `/signout`): the CLI has no `logout` subcommand, ACP and
stream-json answer "Method not found", and `-p /logout` fails with
`NonInteractiveAuthRequiredError`. `qodercli logout` is not a command at all:
it is taken as a prompt, which starts a model turn when signed in. OAR never
deletes Qoder's credential itself (isolated HOME, 2026-11-11).

`authStatus()` reads `qodercli status --output json` and projects its explicit
`logged_in` boolean. A failed query or missing field is `unknown`. Account
details returned by this command never leave the private query.

## Evidence and limits

Required CI pins `@qoder-ai/qodercli@1.1.81` on Linux, macOS and Windows, so
the complete required execution suite covers versions only through 1.1.81.
From 1.1.82, the native replay path no longer drives the suite's scripted
inference, so a model-catalog compatibility fix alone cannot restore these
checks. Assertions and timeouts remain unchanged. Lift the pin only after
native replay works again, or an officially supported local provider passes
all native cases. Daily version probes run the latest release and report
differences; they do not turn failed probes into execution-level coverage.

A separate [2026-11-05 real-flow probe](../../experiments/qoder-deepseek/README.md)
passed inference, native Read/Write tools and cross-process resume on Linux
x64 with Qoder **1.1.83 only**, OAR `4fd225c8`, an existing Free-account login
and a DeepSeek pay-as-you-go API key (Bugen reported three submissions and
removal of the temporary BYOK configuration). It is the first passing execution sample
since 1.1.82 and covers those three flows, not the complete native suite,
cancellation or later Qoder releases. First-party models, subscription quota and rate limits
remain unverified. The manual probe does not enter CI or lift its pin.

The official Unix installation and login URL/cancellation paths were checked
in isolated homes; an existing-machine login completed and its status was
confirmed. Successful conversations, consecutive turns, resume, effort, MCP
and the shared behavior suite used the real 1.1.78 binary with its native
fake-response reader and a fresh home, without account quota. The fake reader
exercises the native agent loop but is not evidence of a particular remote
provider's behavior. First-party conversation and resume remain unverified
after the Credits rejection; the DeepSeek BYOK result uses a different
credential path. Reproduction commands and the first failures are recorded in
[the native evidence guide](../../experiments/qoder-native/README.md).

### Concurrent startup observations

Native session startup is slow and variable. On October 24, 2026, Qoder
1.1.78 from npm typically took about **7 to 25 seconds per session open** in
isolated initialization controls. This includes startup through the initialize
reply, not a model turn. Hosts should allow for this visible delay when
opening or resuming a conversation.

| Platform | Sampling | Initialize duration |
| --- | --- | --- |
| Linux | Two CI rounds, fourteen controls | 6.6 to 10.4 seconds |
| Linux xxwork | Local controls, seven samples | 9.0 to 10.7 seconds |
| macOS | Two CI rounds, fourteen controls | 7.3 to 11.3 seconds |
| Windows | Two CI rounds, fourteen controls | 7.6 to 24.7 seconds |

The [first round](https://github.com/botiverse/oar/actions/runs/40044039964/attempts/1),
[second Windows round](https://github.com/botiverse/oar/actions/runs/40044039964/attempts/2),
[second macOS round](https://github.com/botiverse/oar/actions/runs/40044039964/attempts/3)
and [second Linux round](https://github.com/botiverse/oar/actions/runs/40044039964/attempts/4)
retain the measurements. The controls completed, including reused HOMEs;
copying only the binary cache did not remove the per-open initialization cost.
These small samples are not a latency guarantee. Earlier 30-second failures
retained ongoing native plugin initialization, so that bound did not reliably
distinguish slow startup from a stuck process.

OAR therefore gives a session's `initialize` request **60 seconds on every
platform**, leaving room beyond the measured maximum. This deadline detects a
stuck child; it is not a performance requirement. Later control requests still
have their 30-second bound, and bounded model-list queries retain the caller's
budget. No automatic startup retry or cache copying is added to the adapter.
Hosts can stagger cold session starts to avoid the observed burst; this is a
workaround, not a demonstrated resource limit or a guarantee that all starts
will fit these deadlines. Under startup load a host can also receive an
installation-probe failure even when Qoder is installed; OAR preserves that
failure and its diagnostics and does not report the executable as missing.

CI limits this backend to two concurrent cases on all three platforms. That
stabilizes evidence collection without changing the adapter, assertions or
deadlines; it does not show that product behavior under concurrency is free of
problems, and it is not sufficient evidence of stable startup. Retained CI
observations, whose causes are not established:

- Unbounded (1.1.78, 19 cases on `windows-latest`; not every case creates a
  session, and the simultaneous process count was not recorded): the
  [first run](https://github.com/botiverse/oar/actions/runs/40003398891/job/120585055716)
  exceeded the 15,000 ms native `--help` probe deadline; an
  [unchanged rerun](https://github.com/botiverse/oar/actions/runs/40003398891/job/120596276045)
  completed installation discovery but session opens exceeded the 30,000 ms
  `initialize` deadline. A later
  [Linux run](https://github.com/botiverse/oar/actions/runs/40012665488/job/120616724600)
  also exceeded the help deadline during unbounded startup, despite an earlier
  Linux pass, so this is not established as Windows-specific.
- Two concurrent cases, controlled sequence (one cold initialization, five
  serial native cases, then the behavior suite):
  [Windows](https://github.com/botiverse/oar/actions/runs/40011070963/job/120611286021)
  initialize answered 9.427 seconds after the request (13.713 seconds including
  discovery and startup), the serial cases took 126.89 seconds in total, and
  all applicable behavior cases passed with original assertions and deadlines;
  [Linux](https://github.com/botiverse/oar/actions/runs/40014865655/job/120624217871)
  passed with initialize at 6.979 seconds (9.957 seconds including discovery
  and startup).
- An earlier two-case Windows run completed the shared behavior suite, but
  one native effort test reached its 45-second test deadline
  ([job](https://github.com/botiverse/oar/actions/runs/40012665488/job/120616724464))
  after a successful native result and process exit; the phase consuming the
  remaining time is not established. On the same revision, macOS exceeded the
  old `--help` installation deadline
  ([job](https://github.com/botiverse/oar/actions/runs/40012665488/job/120616724355)).
  The single `--version` installation query removes the extra help call; it is
  not evidence that every observed CI timeout is solved.
- With the single-version query, a
  [Windows run](https://github.com/botiverse/oar/actions/runs/40021337004/job/120646366145)
  still failed three behavior cases at the 30-second initialize deadline,
  without startup stderr or native logs. The replay fixture now retains native
  startup logs in CI artifacts and Qoder CI forwards child stderr, using only
  isolated, unauthenticated replay homes, with no retry, deadline increase or
  further concurrency reduction.
- A [macOS run](https://github.com/botiverse/oar/actions/runs/40023877345/job/120655031487)
  passed the single installation query, then timed out in concurrent
  `--version` queries after 15 seconds, before any session initialized. The
  two-case limit also applies on macOS; the probe deadline is unchanged. This
  does not establish the cause or show that every cold start will fit.
- Windows at concurrency two still exceeded the former 30-second
  initialization bound, including an unchanged rerun of PR #473. Native
  startup logs from [PR #475](https://github.com/botiverse/oar/actions/runs/40040828083)
  repeatedly spent 10 to 15 seconds in `framework.init_builtin_plugins.initialize`;
  two failed processes had not finished that stage. The suite HOME was already
  in use, so this does not establish a first-use extraction cost. The delay
  can affect a real session open as well as tests.

`experiments/qoder-startup.ts` and the opt-in CI pre-suite probe compare a fresh
isolated HOME, a HOME with only `.qoder/.bin` copied, a reused HOME, and two
concurrent starts with shared or separate HOMEs. They submit no model prompt,
copy no credentials or session state, and use a separate HOME from the later
behavior cases. Each result is retained, including failures. The measurement
allows 90 seconds to observe native completion and marks samples exceeding the
current product deadline and the former 30-second deadline separately. Failure
to finish a measurement fails the job. The comparison does not retry failed
behavior cases or promise faster startup. The CI probe is disabled by default.
Set `OAR_QODER_STARTUP_PROBE=1` when collecting startup evidence; ordinary
behavior CI does not pay for these controls.

On October 27, 2026, Qoder 1.1.79 once exited while reading incomplete JSON
from `/tmp/qoder-settings-1cc73090ab49cfc6.json`. Its installed bundle writes
inline `--settings` to a shared temporary path named from the settings'
content hash; that hash matches the failing path. An unchanged suite rerun
passed, and 12 serial plus 12 concurrent inline-setting controls did not
reproduce the error. Twelve concurrent file-path controls also passed. This
supports a shared-file hazard, not a deterministic reproduction or proof of
the failed read's exact timing. Passing a settings file path avoids that
shared inline-settings file. Hosts can pass either native form through
`launchArgs`; OAR does not rewrite or block it. Test fixtures each use their
own immutable file. The later 1.1.80 pass does not establish that native
inline settings no longer share a path. See the
[daily report](../../experiments/runtime-version-checks/2026-10-27.md#qoder-1179)
and the [controls and report draft](../../experiments/qoder-native/inline-settings-report.md).

Fixture cleanup on Windows: native vendor tests perform fixture log copying
and HOME deletion in a separate test-finished hook with a 90-second deadline.
Native controls, session disposal, behavior assertions and their existing
test deadlines stay inside the test body. Cleanup still runs on test failure;
a cleanup rejection or timeout fails CI. An
[instrumented Windows run](https://github.com/botiverse/oar/actions/runs/40047127596/job/120731316729)
measured log copying at about 12 to 34 milliseconds but deletion of
initialized fixture HOMEs at 21 to 43 seconds after native exit. Before the
hook, resume tests reached the whole-test 90-second limit after native turns
completed and processes exited normally (once in round 1, while round 2
passed, and after all three native turns in a
[later failure](https://github.com/botiverse/oar/actions/runs/40048891234/job/120736835381)
without cleanup timers, which cannot identify the exact operation); the
initialize measurements do not explain that remaining time. A
missing-session message in such a job belongs to the expected negative resume
test, not a lost conversation. The hook separates fixture deletion cost from
runtime behavior without claiming that every earlier timeout has the same
cause.

## User configuration selection

`userConfiguration: "exclude"` is refused before launch. No native path has
been verified to exclude user configuration while preserving Qoder's stored
login and session history. Omission and `"include"` retain normal loading.

## Orientation query costs

`listModels()` first reads native auth status, then starts a process and
requests `initialize` and `get_models` with `fetchStrategy: live`. It can perform
account/catalog network I/O and pays native process initialization cost. No model
prompt is submitted. `authStatus()` has no proven no-network declaration and is
therefore skipped by local orientation; it is available at account depth.
On the daemon transport the catalog request is `daemon.get_models`; on the
worker transport it remains `get_models`.

### Model confirmation

An explicit model is confirmed with a `get_models` query (`fetchStrategy:
cache`) in that session's process:

| CLI version | Query when | Confirming name |
| --- | --- | --- |
| Through 1.1.81 | Init name differs from the selector | The selected entry's nonempty `serverModel.display_name` |
| From 1.1.82 (ModelProvider) | Every explicit model, even when init equals the selector | Exactly one entry with that `value`, `modelId` equal to it, and a nonempty `displayName` unique across the entire catalog, including disabled entries |

The same mapping supplies `listModels().resolvedId`; an unverified catalog row
can still be listed but has no inferred `resolvedId`. If the cache cannot
establish the mapping, OAR reads once more with `fetchStrategy: live`. A
verified but different init name refuses opening immediately, without a live
read; a live catalog still lacking a valid, unambiguous mapping also refuses
opening. No names are normalized. Omitted models need no query. Each read
keeps the normal 30-second control deadline; a query error or timeout closes
the process without retrying. There is no second listing process, and private
replies do not enter public records.

[src, env] The [2026-11-05 controls](../../experiments/qoder-native/model-provider-2026-11-05.md)
assert the actual `modelId`/selector/name fields on 1.1.82 and 1.1.83 without
submitting a prompt. An independent Free-account 1.1.83 read confirmed the
enabled `qfmodel` selector and init name `Qwen3.8-Flash`; all 15 catalog display
names were unique. These establish model confirmation, not successful inference
or restored native replay on those versions.

[src, env] Qoder 1.1.78 on xxwork (Linux), 2026-10-29: the enabled selectors
`qfmodel` and `dfmodel` produced `Qwen3.8-Flash` and `DeepSeek-Flash` in init,
exactly matching their catalog fields. `efficient` produced `Efficient`,
while omission selected `Qwen3.8-Flash`. Applied settings contained only
`effort` and `ultracode`, with no model readback. The bundled init projection
reads the selected server model's `display_name`, falling back to the selector.
The native catalog has `live` and `cache` paths, but cache may wait for a
catalog or refresh it in the background; it is not an offline guarantee.
Four same-process cache reads after initialization took 5.2 to 6.7 ms; one
live read took 463 ms. These samples use an existing login and warmed local
state, exclude process initialization, and do not bound cold or remote work.
[Probe, public API comparison and verification limits](../../experiments/qoder-native/model-selection-report.md).

## Reader environment

Installation and model listing accept the same `env` overlay as login and
sessions. Model listing uses it for both auth status and the native catalog;
installation fallbacks use the supplied home directory on each call. See
[reader environments](../spec/orientation.md#environment).

## Native task control

Qoder 1.1.83 emits `system/task_started`, `task_updated.patch`, changed
`task_progress.description`, and `task_notification`. OAR projects the three
existing task events, reads `local_agent` as agent and `killed` as stopped,
and preserves native duplicate notifications. It does not invent a background
flag or child session ID. `stopTask(taskId)` sends native `stop_task`; only
the task notification establishes completion, not the control success.

The real foreground/background stop evidence used a Free login with a
DeepSeek pay-as-you-go custom model, not a Qoder first-party plan: the target
stopped and its peer completed. The probe's later parent prompt was not
reliably correlated and an additional native error result lacked saved
details, so that outcome remains unconfirmed, not a claimed parent success.

[Native evidence and reproducible probes](../../experiments/task-controls/README.md).
