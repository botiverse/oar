# Antigravity 1.5.9 transport and state boundaries

Linux x64, November 15, 2026. Native CLI 1.5.9, SHA-256
`39816d49d5ab92229952987225c23ea3fed7580699dcb4a444e0388e0ac1ce43`.
The original OAR baseline was `6dfd108b`; the final directory control uses
the fix in this change. All providers, accounts, MCP responses, homes and
commands were synthetic and local. No real login or paid model was used.
These results cover the Gemini API-provider path, not Google's signed-in
provider. The CLI's own retries were observed; OAR added none.

The [1.5.9 changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md)
describes more specific failed-turn reporting. The measured ACP path still
reports the failures below as warning text plus `end_turn`. The raw frames
are the evidence, not an inference from that changelog or another host.

## Seven measurements

| Question | Native observation | OAR consequence |
| --- | --- | --- |
| Stream cut / timeout | After an MCP echo succeeds, close an SSE response after one partial text chunk. Native retries, then emits a network warning and `end_turn`. HTTP 504 `DEADLINE_EXCEEDED` also retries, warns and ends normally. A separate open-but-stalled SSE stream remains unanswered at the probe's 180-second bound. | No ACP error to classify. The observation deadline is not a measured native timeout. |
| Mid-turn 401 | `invalid_token` appears in an `agent_message_chunk` warning, then `end_turn`. | OAR records completed and preserves the warning. No claim that a real credential was rejected. |
| Quota / rate limit | Synthetic HTTP 429 `QUOTA_EXHAUSTED` warns and ends immediately; `RATE_LIMIT_EXCEEDED` retries eight times before its ninth injected failure ends the turn. Neither reports `refusal`. | No quota mapping added for an unobserved stop reason. Does not disprove a different signed-in-provider path. |
| Question form | `ask_question` emits a pending tool update and a text question with numbered options, then `end_turn`. No permission request reaches OAR; no choice is sent back. | No silent first-option selection in this control. Other form paths are not established. |
| State directory | GEMINI_HOME points at one temporary directory while HOME points at another. Baseline writes conversation databases under HOME/.gemini. Adding ACP `--gemini-dir` redirects them. The fixed OAR session redirects them with only GEMINI_HOME set. | OAR translates the effective variable into the ACP flag. See the non-ACP limitation below. |
| Background work | `run_command` waits 500 ms for a four-second command, then the root answers at about 1.3 s. At about 4.8 s the command has completed and a new model request runs. No command completion or late model reply reaches ACP during the following 12 s. A late title notification does arrive. | ACP does not expose this background completion; product OAR does not read the database. This measures a background command, not all subagent/scheduler paths. |
| MCP title | Native `name: mcp_echo_echo`, `title: Run mcp_echo_echo`; OAR records `mcp_echo_echo`. Its activity classifier returns `mcp`. | The title prefix causes no name loss in the current projection. |

[observations.json](observations.json) preserves selected ACP frames, OAR
results, provider request contents and times, and database filenames. It
omits provider headers, system prompts and tool catalogs. Temporary paths
are replaced with `<fixture-home>`; synthetic session ids remain. Original
raw files, including unsuccessful/unfinished observations, are retained
locally and fingerprinted in [raw-manifest.json](raw-manifest.json).

## Warning shapes and completed-looking failures

All fault cases first complete `mcp_echo_echo` with `echo:PRE_FAILURE`, so
they are failures after a real native tool round trip. The injected bodies
are defined in [probe.ts](probe.ts); the provider proxy does not infer failure
from the assistant's text.

- 401: `⚠ agent executor error: generating and executing: Error 401, Message: invalid_token: synthetic provider failure, Status: UNAUTHENTICATED, Details: [...]`.
- Quota: the same envelope with `Error 429`, `QUOTA_EXHAUSTED` and `RESOURCE_EXHAUSTED`.
- Rate limit: `⚠ API error (attempt N): Error 429, Message: RATE_LIMIT_EXCEEDED: synthetic provider failure, Status: RESOURCE_EXHAUSTED, Details: [...]`, then an `agent executor error` warning.
- Stream cut: partial text, `⚠ The stream was interrupted. Please continue the task you were working on.`, repeated through native retries, finally `⚠ There was a network issue connecting to the server, please try again.`.
- HTTP 504: the retry and terminal envelopes with `Error 504` and `DEADLINE_EXCEEDED`.

The evidence JSON keeps the full warning strings, including the synthetic
Google RPC error detail, and the native `session/prompt` answer. HTTP 504 is
an explicit server response, not a client-side socket timer. The stalled
stream is recorded as `observation_limit`, with no native terminal response
before probe disposal. It is not counted as a pass or a native timeout.

## Read-only database observations

This section is experiment-only. The adapter does not open SQLite or decode
these blobs. [observe-db.py](observe-db.py) polls only the fixture's temporary
home, opening SQLite with `mode=ro` and `PRAGMA query_only`. Schemas and changed
rows are retained. [inspect-db.py](inspect-db.py) decodes protobuf wire field
numbers without pretending to have the vendor's schema. The selected output
is [database.json](database.json).

The CLI stores SQLite databases under
`<gemini-directory>/antigravity-cli/conversations/<session-id>.db`, with WAL
files, and a separate `conversation_summaries.db`. Relevant tables are:

- `steps`: `idx`, `step_type`, `status`, `has_subtrajectory`, `metadata`,
  `error_details`, `permissions`, `task_details`, `render_info`,
  `step_payload`, `step_format`.
- `conversation_summaries`: counts, status and activity fields, including
  `not_fully_idle`, plus a raw blob. This experiment does not establish a
  general completion contract for those fields.
- Other captured tables include `trajectory_meta`, `gen_metadata`,
  `executor_metadata`, `parent_references`, `trajectory_metadata_blob` and
  `battle_mode_infos`.

The error steps have `step_type = 17`, `status = 3`, `step_format = 0` and
NULL `error_details`. Their detail is in the protobuf `step_payload`:

| Numbered path | Observed content |
| --- | --- |
| `24.3.1` | A terminal summary, absent from the retry-warning records in these samples. |
| `24.3.2` | Error/warning text. |
| `24.3.3` | Detailed stack text on the 401 and 429 terminal records. |
| `24.3.6` | Native record identifier. |
| `24.3.7` | 401 for the 401 terminal record, 429 for both 429 terminals, **2** for the network terminal. It must not be treated uniformly as an HTTP status. |
| `24.3.9` | Terminal error text, including `unexpected EOF` for the stream cut. |

**Type 17 does not mean that the turn has finished.** Stream-cut and
rate-limit retries also append type-17/status-3 warning steps. Their field
`24.3.2` explains the retry; the other terminal fields above are absent in
these samples. This is an observed distinction, not a promised vendor
schema or authorization to derive product outcomes from it.

### Timing relative to the native prompt answer

The observer polls nominally every 10 ms. Times below use the same machine
clock and are rounded; polling and scheduling add delay. First visibility
is an upper bound on the write, not the SQLite commit time. A protobuf
`metadata` field 1 has the wire shape of a seconds/nanoseconds timestamp;
its meaning is not established by a published schema.

| Terminal error | First observed row relative to `end_turn` | Metadata field 1 timestamp relative to `end_turn` |
| --- | ---: | ---: |
| 401 | +14 ms | -2 ms |
| Quota 429 | +6 ms | -3 ms |
| Rate-limit 429, after retries | +9 ms | -3 ms |
| Stream cut, after retries | +10 ms | -5 ms |

The terminal rows were first read shortly **after** `end_turn`; their
embedded timestamps precede it. This measurement cannot determine whether
the SQLite commit preceded the ACP response. A reader must not assume the
row was already visible at the instant the prompt answered. Retry warnings
were visibly present long before the final answer.

The first DB-observed stream/rate runs hit a 120-second observation bound
before retry exhaustion. They are retained as `db-cut` and `db-rate`, with
no claimed native ending. Separate `db-final-cut` and `db-final-rate` runs
used a 240-second bound and reached native endings at about 134 and 164 s,
respectively. The non-DB HTTP-504 control ended at about 143 s. These are
samples, not timeout guarantees.

### Background command after `end_turn`

In the DB-observed control, the root prompt answered at about 1.29 s:

1. Its command row `idx=2`, `step_type=132` remained `status=2`, with
   protobuf text `Running` and a native task id, when the prompt answered.
2. At about **+3.47 s**, that same row became `status=3`, with `Ran` and
   `Command exited with code 0.`. The marker file was present before cleanup.
3. At about **+3.53 s**, a new `idx=4`, `step_type=101` row carried
   `task_notification` and the command's completion message.
4. At about **+3.54 s**, `idx=5`, `step_type=15` contained the scripted late
   model reply. The provider trace independently records that later request.

The command row is updated in place, so watching only new step indexes
would miss its transition. The run/result text and task notification are in
protobuf fields `140`, `148` and `114`; model text is in field `20`.
No matching ACP command completion, task notification or late model reply
was observed. A late title notification is kept, not mistaken for those
missing updates. This evidence supports a transport gap; a product database
reader and a background-task contract require separate design decisions.
The current decision is to keep product code on ACP and document the gaps:
the internal format and its timing are not a stable interface. Upstream
tracking: [failed-turn reporting #1570](https://github.com/google-antigravity/antigravity-cli/issues/1570)
and [background updates #1461](https://github.com/google-antigravity/antigravity-cli/issues/1461).

## State-directory fix and its boundary

Baseline `home-env` and explicit-flag `home-flag` use two fresh temporary
locations. Only the explicit flag redirects native databases. `home-fixed`
uses the same environment-only input against the fixed adapter and writes
all conversation databases under `separate-gemini/antigravity-cli`.

The effective GEMINI_HOME value, inherited or overlaid, now becomes
`--gemini-dir` for every OAR ACP entry: sessions/resume, model listing,
login and logout. Empty or removed values preserve the native default.
OAR never changes the host or child HOME/USERPROFILE behind the caller's
back. Explicit session `launchArgs` still follow OAR's arguments.

CLI 1.5.9 `models` rejects `--gemini-dir` before or after the subcommand;
print mode rejects it too ([native command output](native-flags.json)). Those commands cannot inspect a separately
selected GEMINI_HOME. OAR therefore returns `authStatus: unknown` with a
reason, and `accountUsage: unsupported` / `unsupported_auth_storage`, before
any default-profile query runs. Login/logout can still succeed by the
native ACP result, consistent with their existing unavailable-status rule.

For consistent state selection across all operations, use HOME on POSIX
or USERPROFILE on Windows, with GEMINI_HOME unset or equal to that home's
`.gemini`. Path comparison is lexical and case-insensitive on Windows;
symlink aliases can conservatively be unavailable. No real keyring behavior
was tested or promised by these directory controls.

## Reproduce

Use an explicitly selected native 1.5.9 executable and Node 24 or later.
Python 3 is needed only for the optional SQLite observer. From the repository:

```sh
pnpm tsx experiments/antigravity-native-gaps-2026-11-15/catalog.ts /path/to/agy /tmp/catalog.json
pnpm tsx experiments/antigravity-native-gaps-2026-11-15/probe.ts /path/to/agy question /tmp/question.json 240
OAR_PROBE_DATABASE=1 pnpm tsx experiments/antigravity-native-gaps-2026-11-15/probe.ts /path/to/agy cut /tmp/cut.json 240
python3 experiments/antigravity-native-gaps-2026-11-15/inspect-db.py /tmp/cut.json > /tmp/cut-db.json
```

Modes: `home-env`, `home-flag`, `question`, `mcp`, `background`, `401`,
`quota`, `rate`, `cut`, `deadline`, `stall`. After this fix, `home-env`
exercises OAR's translation; use baseline `6dfd108b` with the same probe to
reproduce the old leak. Every run removes only its temporary fixture after
retaining results. The probe's bound is not an adapter timeout.

Five regressions failed before the fix and passed afterwards: native model
listing, login, logout, auth status and usage all select or refuse the
requested profile correctly. Additional controls cover inherited/overlaid
values, null removal, empty values, default-path equivalence and Windows
USERPROFILE/case rules.

## Validation

[Validation counts and log fingerprints](validation.json) retain the local
results. The original logs remain with the measurement artifacts.

- `CI=1 pnpm run check`: type checks, lint, 4,272 tests and 18 mock behavior
  cases passed on Linux.
- Focused Antigravity tests: 74 passed, one skipped. The five initial
  regression failures remain in the local before-fix log.
- Shared behavior suite: all 15 configured backends passed.
- Native Antigravity 1.5.0: 17 behavior cases passed, retaining coverage of
  the supported ACP floor.
- Native Antigravity 1.5.9: all 14 vendor tests passed; the final
  environment-only directory control wrote its databases exclusively under
  the requested GEMINI_HOME.

Cross-platform CI is separate. The Windows path/environment tests are
synthetic, not a native Windows login or keyring measurement.

After rebasing onto `945c6959` (the config-notification fix), the full check
passed again: 4,291 tests and 18 mock behavior cases. Antigravity 1.5.0
behavior (17 cases) and 1.5.9 vendor tests (14 cases) also passed again. The
only rebase conflict was the experiment index; both entries are retained.
