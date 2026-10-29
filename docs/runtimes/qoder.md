# Qoder

OAR uses Qoder's native bidirectional JSON-line SDK protocol, with one
owned process per open session. Qoder 1.1.78 through 1.1.80 use `--print
--input-format stream-json --output-format stream-json` and the native stdio
permission flag. From 1.1.81, OAR uses `--sdk` and the official SDK's daemon
protocol. The old worker interface was probed on 1.1.78, Linux, on October 23,
2026; the daemon migration was verified on October 29
([evidence and reproduction](../../experiments/qoder-native/daemon-2026-10-29.md)).
The 1.1.79 recheck on October 27 passed eight native cases, 17 shared
behavior cases (two skipped), and all eight native priority controls after
isolating the test settings files. The first shared run's startup failure
and the unchanged passing recheck are retained in the
[daily report](../../experiments/runtime-version-checks/2026-10-27.md#qoder-1179).
On October 28, **1.1.80** passed the same eight native cases, 17 shared
cases (two skipped) and eight priority controls on the first run, using
separate settings files ([report](../../experiments/runtime-version-checks/2026-10-28.md#qoder-1180)).
This does not establish that native inline settings no longer share a path.
Those replay checks used no real account or paid provider. The later
[model-selection probe](../../experiments/qoder-native/model-selection-report.md)
uses an existing login for catalog reads and opens, without a model prompt.

## Transport versions

[src] Qoder 1.1.81 explicitly rejects the old SDK worker with
`sdk_worker_removed`. Removing `--permission-prompt-tool stdio` from ordinary
headless stream-json is insufficient: that path accepts user input but no
longer processes the SDK's `initialize` control. This is an intentional
transport removal. On October 29, the published official
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
An unreadable or non-stable CLI version refuses opening explicitly as a
version compatibility error instead of guessing a permission transport.

The daemon uses the child environment's personal access token or service-account
key when supplied, otherwise the native local `qodercli` login. A service-account
key combined with another explicit credential is refused, as in the native CLI.
A job token without a personal access token is refused: the official daemon
requires a host callback for that auth mode, which OAR does not implement.
Authentication travels only in the private handshake, never argv or records.

[env] One native 1.1.81 daemon ran two sessions concurrently on Linux; closing
one left the other able to complete another turn. This is only a routing and
basic close observation. OAR still owns one daemon per session, and shared
placement requires the full [design evidence gate](../design/system.md#shared-runtime-processes).
The native permission regression explicitly switches a replay session to the
native default permission mode to trigger `can_use_tool`, proves the tool has
not run before the response, and uses the production stdio response policy to
allow it. Normal OAR sessions retain `bypass_permissions`. The synthetic login
fixture depends on the native credential storage format; a format change must
fail native CI explicitly rather than silently substituting a real login.
Unknown daemon frames without a session id remain verbatim in records. A frame
for another session stops the owned daemon with an explanatory `exited.reason`;
its foreign content is not attributed to the current conversation.

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
| Model and effort | `--model` accepts the catalog's `value` (`ModelEntry.id`). Init may report the catalog's `serverModel.display_name`, exposed as `resolvedId` only when non-empty and different from `id`; a mismatch with the requested id is confirmed by an exact lookup in the same process's native catalog. `model()` retains the init name. `--reasoning-effort` is confirmed by applied settings. A startup failure includes the requested effort as context, without claiming it caused the failure; a later model-confirmation error keeps its model-specific reason. Failure to confirm an explicit choice refuses opening. |
| Prompt and abort | Correlated native controls and lifecycle evidence. A cancelled unstarted input becomes `input_dropped`; input-scoped waits resolve it without inventing `turn_ended`. |
| Queue and withdrawal | OAR holds queued input until the current turn ends, so withdrawal remains possible. This queue is not durable across process loss. |
| Steer | A user message with native `priority: next` inserts at a tool boundary or starts after a text-only turn. The user echo preserves `inputId`; acceptance only confirms the write. Native `now` aborts the active turn and is not used for steering. [Priority evidence](../../experiments/qoder-native/README.md#input-priority-2026-10-24). |
| MCP | Native stdio and HTTP servers through a private per-process configuration file. Credentials are omitted from argv and redacted from public records. |
| System and tools | Native system/append prompt files, additional-directory and disallowed-tool startup flags. Native global configuration still applies. |
| Unsupported options | `serviceTier`, `outputSchema` and persisted session `name` are explicitly refused. Image input is refused. |
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
behavior suite. The [initial Windows run](https://github.com/botiverse/oar/actions/runs/40050232565/job/120741056271)
passed both steering cases but failed an older effort test after native
completion and exit. That revision included fixture cleanup in the whole-test
deadline and did not measure its exact remaining cost. The later run uses
the separate bounded cleanup hook described below.

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

`authStatus()` reads `qodercli status --output json` and projects its explicit
`logged_in` boolean. A failed query or missing field is `unknown`. Account
details returned by this command never leave the private query.

## Evidence and limits

The official Unix installation and login URL/cancellation paths were checked
in isolated homes; an existing-machine login completed and its status was
confirmed. Successful conversations, consecutive turns, resume, effort, MCP
and the shared behavior suite used the real 1.1.78 binary with its native
fake-response reader and a fresh home. They did not use account quota.

Successful real-provider conversation and resume remain unverified because of
the Credits rejection. Earlier Linux and macOS native CI passed. Windows and
Linux each passed a cold initialize probe, five serial native tests and all
applicable shared behavior cases with two concurrent cases. Unbounded parallel
startup exceeded existing help, version or initialize deadlines, so CI on
all three platforms limits this backend to two concurrent cases. That change left
the adapter, assertions and deadlines unchanged. The later initialization
measurement below motivated a separate product deadline adjustment.
The fake reader exercises the native agent loop but is not evidence of a
particular remote provider's behavior. Reproduction commands and the first
failures are recorded in [the native evidence guide](../../experiments/qoder-native/README.md).

### Concurrent startup observations

On October 27, 2026, Qoder 1.1.79 once exited while reading incomplete JSON
from `/tmp/qoder-settings-1cc73090ab49cfc6.json`. Its installed bundle writes
inline `--settings` to a shared temporary path named from the settings'
content hash; that hash matches the failing path. An unchanged suite rerun
passed, and 12 serial plus 12 concurrent inline-setting controls did not
reproduce the error. Twelve concurrent file-path controls also passed. This
supports a shared-file hazard, not a deterministic reproduction or proof of
the failed read's exact timing. Passing a settings file path avoids that
shared inline-settings file. Hosts can pass either native form through
`launchArgs`; OAR does not rewrite or block it. Test fixtures now each use
their own immutable file. See the [controls and report draft](../../experiments/qoder-native/inline-settings-report.md).

On `windows-latest` with Qoder 1.1.78, the behavior suite starts 19 cases
without a concurrency cap; skipped and query-only cases do not all create
sessions, and the exact simultaneous process count was not recorded.
The [first run](https://github.com/botiverse/oar/actions/runs/40003398891/job/120585055716)
exceeded the 15,000 ms native `--help` probe deadline. An
[unchanged rerun](https://github.com/botiverse/oar/actions/runs/40003398891/job/120596276045)
completed installation discovery but session opens exceeded the 30,000 ms
`initialize` deadline. Both failures remain evidence; their cause is unknown.

The [controlled Windows comparison](https://github.com/botiverse/oar/actions/runs/40011070963/job/120611286021)
ran one cold initialization, then five serial native cases, then the same
behavior suite with at most two active cases. Initialization answered after
9.427 seconds from sending the request, or 13.713 seconds including discovery
and startup. The serial cases took 126.89 seconds in total; all applicable
behavior cases passed with their original assertions and deadlines.

A later [Linux run](https://github.com/botiverse/oar/actions/runs/40012665488/job/120616724600)
also exceeded the 15,000 ms help deadline during unbounded startup, despite an
earlier Linux pass. This is therefore not established as Windows-specific.
A [controlled Linux comparison](https://github.com/botiverse/oar/actions/runs/40014865655/job/120624217871)
then passed the cold handshake, five serial native cases and all applicable
behavior cases at concurrency two. Its initialize response took 6.979 seconds
from the request, or 9.957 seconds including discovery and startup.
Hosts can stagger cold session starts to avoid the observed burst; this is a
workaround, not a demonstrated resource limit or a guarantee that all starts
will fit these deadlines. Limiting test concurrency stabilizes evidence
collection; it does not show that product behavior under concurrency is free
of problems. OAR adds no startup retry. The later measurements below explain
the separate initialization deadline change.

An earlier two-case Windows run completed the shared behavior suite, but
one native effort test reached its 45-second test deadline
([job](https://github.com/botiverse/oar/actions/runs/40012665488/job/120616724464)).
Its retained records include a successful native result and process exit
before that deadline; they do not establish which later phase consumed the
remaining time. On the same revision, macOS also exceeded the old `--help`
installation deadline ([job](https://github.com/botiverse/oar/actions/runs/40012665488/job/120616724355)).
The single-version installation query removes the extra help invocation;
it is not evidence that every observed CI timeout is solved. That revision left native control
and test deadlines unchanged; the later measurement below covers initialization.

The [single-version revision's Windows run](https://github.com/botiverse/oar/actions/runs/40021337004/job/120646366145)
still failed three behavior cases at the 30-second initialize deadline, with
two active cases. The trace does not retain startup stderr or native logs,
so it does not establish the cause. The replay fixture now retains native
startup logs in CI artifacts, and Qoder CI forwards child stderr. These
diagnostics use only isolated, unauthenticated replay homes. That diagnostic
change added no retry, deadline increase or further concurrency reduction.

The [latest macOS run](https://github.com/botiverse/oar/actions/runs/40023877345/job/120655031487)
passed the suite's single installation query, then timed out in concurrent
`--version` queries after 15 seconds, before any session initialized. The
existing two-case CI limit now also applies on macOS; the probe deadline is
unchanged. Hosts can therefore receive an installation-probe failure under
startup load even when Qoder is installed. OAR preserves that failure and
its diagnostics; it does not report the executable as missing. The single
success and concurrent failures do not establish the underlying cause or
show that every cold start will fit the deadline.

The concurrency cap is not sufficient evidence of stable startup. Subsequent
Windows runs at concurrency two still exceeded the 30-second initialization
bound, including an unchanged rerun of PR #473. Native startup logs from
[PR #475](https://github.com/botiverse/oar/actions/runs/40040828083) repeatedly
spent 10 to 15 seconds in `framework.init_builtin_plugins.initialize`; two
failed processes had not finished that stage. The same suite HOME was already
in use, so these observations do not establish a first-use extraction cost.
This delay can affect a real session open as well as tests.

`experiments/qoder-startup.ts` and the opt-in CI pre-suite probe compare a fresh
isolated HOME, a HOME with only `.qoder/.bin` copied, a reused HOME, and two
concurrent starts with shared or separate HOMEs. They submit no model prompt,
copy no credentials or session state, and use a separate HOME from the later
behavior cases. Each result is retained, including failures. The measurement
allows 90 seconds to observe native completion and marks samples exceeding the
current product deadline and the former 30-second deadline separately. Failure to finish a measurement fails the job. The
comparison does not retry failed behavior cases or promise faster startup.

The CI probe is disabled by default. Set `OAR_QODER_STARTUP_PROBE=1` when
collecting startup evidence; ordinary behavior CI does not pay for these controls.

On October 24, 2026, Qoder 1.1.78 from npm typically took about **7 to 25
seconds per session open** in these isolated initialization controls. This
includes startup through the initialize reply, not a model turn. Hosts should
allow for this visible delay when opening or resuming a conversation.

| Platform | Sampling | Initialize duration |
| --- | --- | --- |
| Linux | Two CI rounds, fourteen controls | 6.6 to 10.4 seconds |
| Linux xxwork | Local controls, seven samples | 9.0 to 10.7 seconds |
| macOS | Two CI rounds, fourteen controls | 7.3 to 11.3 seconds |
| Windows | Two CI rounds, fourteen controls | 7.6 to 24.7 seconds |

The [first round](https://github.com/botiverse/oar/actions/runs/40044039964/attempts/1),
[second Windows round](https://github.com/botiverse/oar/actions/runs/40044039964/attempts/2)
[second macOS round](https://github.com/botiverse/oar/actions/runs/40044039964/attempts/3),
and [second Linux round](https://github.com/botiverse/oar/actions/runs/40044039964/attempts/4)
retain the measurements. The controls completed, including reused HOMEs;
copying only the binary cache did not remove the per-open initialization cost.
These small samples are not a latency guarantee. Earlier 30-second failures
retained ongoing native plugin initialization, so that bound did not reliably
distinguish slow startup from a stuck process.

OAR now gives a session's `initialize` request **60 seconds on every platform**,
leaving room beyond the measured maximum. This deadline detects a stuck child;
it is not a performance requirement. Later control requests still have their
30-second bound, and bounded model-list queries retain the caller's budget.
No automatic startup retry or cache copying is added to the adapter.

One Windows native resume test in round 1 reached its whole-test 90-second
limit after both native processes had logged normal exits; round 2 passed.
A missing-session message in the same job belongs to the expected negative
resume test and is not evidence of a lost conversation. The failed test's
remaining time is not explained by the initialize measurements. The fixture
now records log-copy and HOME-removal boundaries to identify cleanup delays
without changing that test's assertion or deadline.

The later [instrumented Windows run](https://github.com/botiverse/oar/actions/runs/40047127596/job/120731316729)
measured log copying at about 12 to 34 milliseconds, but deletion of initialized
fixture HOMEs took 21 to 43 seconds after native exit. A
[subsequent resume failure](https://github.com/botiverse/oar/actions/runs/40048891234/job/120736835381)
again reached the whole-test limit after all three native turns completed and
both processes exited successfully. That failed revision had no cleanup
timers, so it cannot identify the exact operation consuming its remaining time.

The native vendor tests now perform fixture log copying and HOME deletion in
a separate test-finished hook with a 90-second deadline. Native controls,
session disposal, behavior assertions and their existing test deadlines stay
inside the test body. Cleanup still runs on test failure; a cleanup rejection
or timeout fails CI. This separates fixture deletion cost from runtime
behavior without claiming that every earlier timeout has the same cause.

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

An explicit model whose init name differs from the requested selector adds
one `get_models` query with `fetchStrategy: cache` in that session's process.
If the selected entry or its native name is missing, OAR reads once more with
`fetchStrategy: live`, allowing a model from a fresh listing to be confirmed.
A present but different name refuses opening immediately, without a live read.
There is no second listing process, and omitted models or direct init matches
need no catalog query. Only the selected entry's non-empty
`serverModel.display_name` can confirm the mismatch; OAR does not normalize
names or substitute a display label. The query keeps the normal 30-second
control deadline for each read (at most two reads), and a query error or timeout
closes the process without retrying. A live result still missing the entry or
its native name also refuses opening. The private responses do not enter
public records.

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
