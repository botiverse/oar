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
materialize its own files under `~/.qoder` during startup.

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
the Credits rejection. Windows and macOS native behavior has not been tested.
The fake reader exercises the native agent loop but is not evidence of a
particular remote provider's behavior. Reproduction commands and the first
failures are recorded in [the native evidence guide](../../experiments/qoder-native/README.md).
