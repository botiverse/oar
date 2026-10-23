# Qoder

Qoder CLI exposes a bidirectional JSON-line protocol through `--print
--input-format stream-json --output-format stream-json`. OAR uses this native
interface, with one process per open session. The interface and the bundled
implementation were probed on Qoder 1.1.78, Linux, on October 23, 2026.

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
ids, display names, default selection, effort levels and disabled entries.
These queries do not require a prompt. Configuration and account responses
are private: OAR exposes only the applied readback and model fields, never
identity, organization data or authentication material.

## OAR mapping

| Surface | Mapping and boundary |
| --- | --- |
| Session | Native session UUID; `--resume` opens its saved conversation. A missing id is refused, without creating a replacement. |
| Model and effort | `--model` and `--reasoning-effort`, confirmed from native init and applied settings. Failure to confirm an explicit choice refuses opening. |
| Prompt and abort | Correlated native controls and lifecycle evidence. A cancelled unstarted input becomes `input_dropped`; input-scoped waits resolve it without inventing `turn_ended`. |
| Queue and withdrawal | OAR holds queued input until the current turn ends, so withdrawal remains possible. This queue is not durable across process loss. |
| Steer | Absent. A native active-turn injection mechanism has not been verified. |
| MCP | Native stdio and HTTP servers through a private per-process configuration file. Credentials are omitted from argv and redacted from public records. |
| System and tools | Native system/append prompt, additional-directory and disallowed-tool startup flags. Native global configuration still applies. |
| Unsupported options | `serviceTier`, `outputSchema` and persisted session `name` are explicitly refused. Image input is refused. |
| Cleanup | EOF permits normal idle shutdown; active disposal and bounded shutdown use process-tree cleanup. Native exit is recorded. |

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
startup exceeded existing help or initialize deadlines, so Windows and Linux
CI limit this backend to two concurrent cases. The adapter, assertions and
deadlines are unchanged.
The fake reader exercises the native agent loop but is not evidence of a
particular remote provider's behavior. Reproduction commands and the first
failures are recorded in [the native evidence guide](../../experiments/qoder-native/README.md).

### Concurrent startup observations

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
of problems. OAR adds no startup retry and does not extend native deadlines.
