# Qwen Code

Qwen owns a process, a persisted conversation UUID and a sequence of turns.
OAR uses the native CLI's bidirectional SDK channel, not its ACP interface:
`qwen --input-format stream-json --output-format stream-json --channel=SDK`.
The first stdin frame is a control `initialize` request. A user frame first
would select direct mode and disable the control dispatcher.

Baseline: npm `@qwen-code/qwen-code` **0.26.0**, published source
[`ac97ce7a`](https://github.com/QwenLM/qwen-code/tree/ac97ce7a70d9b2ea5d62b357e3d9b0851423afc9),
observed on Linux with a local scripted OpenAI provider on 2026-10-23.
The source's `packages/cli/src/nonInteractive/session.ts` and
`control/controllers/systemController.ts` define this interface.

Rechecked npm **0.26.1** on Linux on 2026-10-25: all six native vendor tests,
16 applicable shared behavior cases and the four direct protocol scenarios
passed. The warm-HOME lock probe still separates initialize acknowledgement
from first-prompt readiness. The official standalone install also passed in
an isolated HOME; see the [version check](../../experiments/runtime-version-checks/2026-10-25.md#qwen-0261)
for evidence and limits.

## OAR mapping

`qwenRuntime` is in `defaultRuntimes` and available separately from
`@botiverse/oar/runtimes/qwen`. Install the vendor executable with
`npm install -g @qwen-code/qwen-code`; `OAR_QWEN_BIN` selects another copy.
The npm CLI requires Node 22 or newer; the official standalone archive bundles
its runtime. OAR itself requires Node 24 or newer.

| Surface | Mapping and limits |
|---|---|
| Open / resume | New UUID via `--session-id`; existing UUID via `--resume`, never both. Native history is restored, but OAR starts a fresh record stream and does not replay old frames. Use the same HOME and project directory. |
| Prompt | Native user envelope on stdin; acceptance means OAR wrote it, not native execution. Each root `system/init` establishes activity; the native `result` ends that turn. |
| Queue / withdraw | OAR holds input until the active result, so pending input can be withdrawn. Native busy writes become an irreversible native queue; OAR does not use them. No `steer` member, `queue.durable: false`. |
| Abort | `interrupt` control request and its matched native reply; completion still comes from `result`. Abort fallback terminates an unresponsive process. |
| Dispose | Idle sessions close stdin and allow up to five seconds for native cleanup, then terminate the process tree. Active turns are terminated with their process tree. No synthetic completion is reported. |
| Model | Optional `--model`; readback is the model in each native `system/init`, never the requested selector echoed back. |
| Effort | Optional `initialize.effort`. Open requires `effort_status` to name the requested level with `applied: true`, `override: null`. Without a report it remains null. No model-name-based effort table. |
| Models | `initialize`, then `get_available_models`, without a prompt. Native ids, labels and explicit reasoning menus are projected. Environment-only model configuration can produce an empty catalog; OAR does not invent an entry. |
| Instructions / directories | `--system-prompt`, `--append-system-prompt`, `--include-directories`. Additional directories are resolved against the session cwd. |
| Tool denial | Native `--exclude-tools`; matching and aliases are Qwen's. |
| MCP | Per-session `initialize.mcpServers`: stdio command/args/env or streamable HTTP `httpUrl`/headers. Pass again on resume. Credentials do not enter the Qwen command line or OAR records. |
| Permissions | Explicit native `--approval-mode yolo`; Qwen's default auto mode uses a model classifier. If `can_use_tool` still arrives, OAR records the app request and sends Qwen's allow/updatedInput response. |
| Images | Rejected before input submission; `images: false`. |
| Structured output | Refused with `UnsupportedOptionError`: native 0.26.0 explicitly disallows `--json-schema` with stream-json input. No adapter emulation. |
| Install | Official standalone installer on macOS/Linux, checksum verification by the vendor script, with `--method standalone --no-modify-path`. No npm fallback or shell-profile change. Windows returns unsupported with the official PowerShell instructions. |
| Login | No `login` member. Native `qwen auth` was removed. Configure a provider externally, for example OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL. No OAR login prompt or browser flow. |
| Authentication status | Local user/system credential presence only. Configured or indeterminate sources return `unknown`; none in scope returns `logged_out` with setup guidance and a workspace caveat. No credential validation, native process, network request or write. |
| Other surfaces | No service tier or session-name setting; no account quota, inventory, updater, live configure or context breakdown mapping. |

The install plan checks writes to both the executable directory and the library
parent (the installer stages and replaces the library there). Discovery and
permission checks honor the vendor's `QWEN_INSTALL_ROOT`,
`QWEN_INSTALL_LIB_PARENT`, `QWEN_INSTALL_LIB_DIR` and `QWEN_INSTALL_BIN_DIR`.
Without overrides, installation uses `~/.local/lib/qwen-code` and
`~/.local/bin/qwen`. OAR discovers this executable immediately without editing
PATH. The vendor may print a PATH recommendation; OAR does not apply it.

On 2026-10-23, a Linux sandbox with an empty HOME and no Qwen on PATH ran
OAR's actual `install()` against the official installer. It installed 0.26.0,
`installation()` found the executable outside PATH, a sentinel `.bashrc`
remained byte-for-byte unchanged, and a second `install()` reported
`already_installed`. No authentication or model request was performed. This
is Linux installation evidence, not a macOS or Windows installation claim.

Discovery uses one `--version` query, without a preceding `--help` process.
A timed-out executable remains a probe failure, never `not_found`.
The [installation probe](../../experiments/qwen-native/installation.ts) compared
both commands in three fresh homes and again in each same home on Linux with
0.26.0. The standalone version query took 49 to 78 ms cold and 50 to 52 ms warm;
help took 104 to 123 ms cold and 104 to 114 ms warm. The npm version query took
100 to 186 ms cold and 65 to 162 ms warm; help took 119 to 263 ms cold and
102 to 142 ms warm. The npm ranges overlap, but one version query avoids a
second process regardless. Neither command created `.qwen` in these homes.
These measurements do not establish startup times under concurrent CI load.

Qwen emits `stream_event`, assistant, tool-result user and result messages
without Claude's `command_lifecycle` acknowledgements. The shared stream-json
fold uses a separate no-lifecycle policy: native init starts the sole submitted
input, and no Claude acknowledgement sets are populated. It preserves native
frames and uses `parent_tool_use_id` for attributed child activity. This is
attribution within a conversation, not a graph of independent child sessions.

Qwen can append an auto-memory reminder to its provider request after a tool
result. In the observed 0.26.0 SDK output, that reminder is not emitted at all;
the native `user` frame contains only `tool_result`. OAR preserves this frame
and projects the tool result, with no `user_message` or host `inputId`. Text
alongside a tool result or in a separate non-replay runtime user frame is also
retained only in the native frame. The provider request is probe evidence,
not an additional OAR input or record.

## Usage and failures

`result.usage` is cumulative over the entire native conversation, including
restored history and auxiliary model work. Cache reads are already included
in input. For a fresh conversation OAR exposes that cumulative total without
assigning all of it to the root agent. On resume, **`usage().total` remains
null**: 0.26.0 exposes no trustworthy session total before the first new turn.
`get_usage_info` is a global daily dashboard, and `get_context_usage` measures
context occupancy; neither is a baseline. The raw native totals remain in the
record stream. The first resumed result is not subtracted as a baseline,
because that would lose the first new turn's spend.

A native result error retains its original message. Unclassified execution
failures remain `unknown`; `error_max_turns` is `limit_reached`, and a result
following an OAR abort is `aborted`. No authentication or quota cause is inferred
from arbitrary text. Native context and compaction readbacks are not projected
into `contextUsage()` in this adapter.

### Extension-store contention

**Finishing one warmup turn does not make shared-HOME concurrency safe.**
Qwen 0.26.0 can return `Extension store is busy` after a successful warmup:
[Windows evidence](https://github.com/botiverse/oar/actions/runs/40012665488/job/120616724695)
and [Linux evidence](https://github.com/botiverse/oar/actions/runs/40017461632/job/120633110675)
include failed first turns from later sessions. Each job ran 19 behavior cases
concurrently, including session and model-list processes, against a shared
HOME. The Linux runner used Ubuntu 24.04.5 with Node 24.21.0; the Windows
runner used Windows Server 2025 with Node 24.22.1. OAR does not retry this
failure. The earlier [cold-start observation](../../experiments/qwen-native/evidence.json)
remains valid but does not establish a warmup workaround. The native vendor
test holds the on-disk lock to reproduce the error deterministically.

Native `initialize` replies before extension initialization finishes. Its
control queries do not establish readiness either. A [warm-HOME lock probe](../../experiments/qwen-native/lock-lifetime.ts)
confirmed that `initialize` completed in 1.65 seconds while an external lock
remained held; the first prompt reached no provider until that lock was
released. An ordinary later prompt completed with a held lock, which does
not establish that extension refresh operations never acquire it again.
The same probe on 0.26.1 on 2026-10-25 returned initialize in 1.755 seconds
while the lock was held, then reproduced the blocked first prompt and
successful later prompt. The lock limitation therefore remains.
Serializing launches only through the initialize response is insufficient. Therefore this failure can
arrive at the **first prompt**, as `result/error_during_execution`, after OAR
has returned the Session. It ends that turn as `failed/unknown` with the native
message; it is not an authentication/model classification or a silent wait.
The adapter cannot honestly move it to open without a native readiness signal.
The Windows failure also exposed a test-fixture cleanup bug: three assertions
failed before their sessions' explicit `dispose` calls, and those sessions had
no exit records before recursive removal hit `EBUSY`. The shared behavior
runner now disposes every session opened by a case, including failed cases,
before removing fixture directories. That cleanup does not hide or retry the
original extension-lock failure.

Closing an idle process uses EOF so initialization can release its lock; an
immediate hard termination during initialization can leave a stale lock.

### Process startup under concurrent load

On macOS, concurrent cold starts also exceeded the 30-second initialization
bound after each session received a separate HOME. The
[retained macOS job](https://github.com/botiverse/oar/actions/runs/40027351971/job/120666756618)
scheduled 19 behavior cases together; 16 cases reported an `initialize`
timeout. No session opened, so these are timeout observations, not measured
successful startup durations. Separate HOMEs prevent those sessions sharing
the extension store, but do not guarantee timely initialization under load.
The cause is not established: the trace cannot distinguish native startup
work from CI CPU or I/O contention. Hosts should stagger cold starts.

In CI, the Qwen behavior backend now runs at most two cases concurrently on
Linux, macOS and Windows. Before those cases, it opens one session in a new
HOME, records initialization and first-turn durations separately, and closes
it. The later cases use different new HOMEs; this is a timing sample, not a
shared-HOME warmup or a retry. Its result and every later session's open time
are retained in the `qwen-aimock/trace.jsonl` artifact. A failed sample fails
the job. Product deadlines, assertions and retries are unchanged. Reproduce
the CI setup with `CI=1 OAR_TEST=qwen-aimock pnpm sea-trial`; outside CI the
suite keeps its normal concurrency unless `OAR_TEST_CONCURRENCY` is supplied.

On 2026-10-23, GitHub Actions `windows-latest` (Windows Server 2025,
`windows-2025-vs2026` image 20261021.278.1, Node 24.22.1) ran 19 behavior
cases concurrently against Qwen 0.26.0. The fixture had already finished one
warmup turn in that HOME. Most newly launched sessions opened about 15 to
17 seconds after their cases started; the separate model-list process failed
to answer `initialize` within its former 15-second default. All other cases
passed. These are measured case-to-open times under concurrent CI load, not
isolated startup benchmarks. The trace does not identify a lock, CPU or I/O
cause. [First failing job and retained artifact](https://github.com/botiverse/oar/actions/runs/39978507452/job/120499331029).

Model listing now uses the same 30-second control-request default as session
opening, since both launch the full native CLI. For comparison, OAR's CLI
model readers use 15 seconds for Claude and Codex, 10 for Grok, and 30 for
Kimi, Antigravity and OpenCode. The Qwen bound accommodates observed native
startup instead of making the test fixture more permissive than the product.
Hosts can still pass `listModels(installation, { timeoutMs })` for a different
per-control-request bound. A timeout closes stdin and then force-cleans an
unresponsive process after the normal cleanup grace; it never retries.

## Evidence and verification

- [Direct native probe](../../experiments/qwen-native/README.md): initialization,
  two prompts, resume, cumulative usage, actual MCP call, permission reply and
  interrupt. Uses a temporary HOME, local provider and synthetic credentials.
- [Native vendor tests](../../sea-trial/vendor/qwen.vendor.test.ts): fresh/resume
  counts, model menu and effort, MCP stdio/HTTP credential delivery, instructions,
  tool denial, missing resume and native extension-lock failure. The persisted
  credential audit scans all fixture files after both native processes exit;
  a completed turn alone does not stop background model-registry writes.
- [No-lifecycle regression](../../tests/qwen/session.test.ts): busy checks before
  the next init, queue drain, withdrawal, abort, later prompts and disposal.
  [Pure fold tests](../../tests/qwen/projection.test.ts) assert empty acknowledgement
  sets, usage and confirmed settings. Claude's 26 original recording baselines
  remain unchanged.
- `OAR_TEST=qwen-aimock pnpm sea-trial` runs the shared contract suite against the
  real CLI. New sessions use separate temporary HOMEs so one native process cannot
  poison another test's extension-store lock. Resume reuses that session's
  original HOME and cwd. The shared-HOME limitation remains covered by the
  separate native lock probe, rerun whenever the Qwen version changes. There
  is no adapter retry, altered assertion or test-only product timeout.

These tests do not establish real provider authentication, billing, live nested
subagent interleavings, or runtime MCP list-change notification behavior. The
latter retains the conservative default declaration. Real-account validation
is left to the consuming host; none was used to develop this adapter.

## User configuration

`userConfiguration: "exclude"` is declared refused with
`UnsupportedOptionError` before opening a session. This adapter has no
verified separation of user configuration from native login and session
history. Omission and `"include"` retain existing behavior. See the
[shared contract](../spec/runtime-matrix.md#user-configuration).

## Authentication status

[source, 0.26.2] Native `qwen auth` was removed; OAR exposes no login or
logout flow. Qwen says its OAuth free tier ended on **2026-04-15**. Configure
a provider externally: `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `OPENAI_MODEL`,
a Bailian plan key and its regional plan endpoint, or an OpenRouter/Requesty
key and provider endpoint. These are configuration instructions, not proof
that an account or endpoint works.

`authStatus()` is a local presence observation with the same inherited
environment and explicit `env` overlay as a session. It reads user and system
settings (`security.auth`, `settings.env`, and variables referenced by
`modelProviders[].envKey`), native provider-key variables, and the user-level
`.env` files Qwen reads independently of a workspace walk: the global Qwen
configuration directory, legacy `~/.qwen`, and the home directory. It honors
`QWEN_HOME`, including its user `.env` bootstrap, and the native system settings
path overrides. JSONC and dotenv are parsed without running Qwen's settings
loader, migrations or provider setup. Existing files are not modified.

Project settings, workspace `.env` files and launch arguments such as
`--openai-api-key` are outside this machine/user observation. `AuthStatusOptions`
does not add `cwd` or `launchArgs`. Any configured source in scope gives
`unknown`, including a source shadowed by another setting. The reader does not
choose an effective provider or test a key. Its detail names source kinds,
environment variable names or a known `selectedType`, never values. A selected
API-key protocol or a model entry with an unset key alone is not a credential.

Vertex ADC and legacy Qwen OAuth files are checked for existence only, without
reading their tokens. A missing explicit ADC file, external authentication,
or a Vertex configuration that might use metadata credentials remains
`unknown`; offline evidence cannot establish their usability. The ADC locations
follow [Google's documented lookup](https://docs.cloud.google.com/docs/authentication/application-default-credentials).
Malformed, unreadable, oversized or unrecognized-version configuration and a
query timeout also produce `unknown` with generic detail. No key helper,
Google credential client, token refresh or network request runs. The reader
therefore declares `localOnly: true`.

Only when no source is found in scope does it return `logged_out`. Its detail
includes provider setup guidance and says that project settings, workspace
`.env` or launch arguments may still supply credentials. This is not a claim
that every workspace session will fail. `orient()` uses the existing
logged-out skip rule for account/model reads; hosts that need a particular
workspace's catalog can call `listModels()` directly.

Evidence: the pinned [0.26.2 source](https://github.com/QwenLM/qwen-code/tree/402911146f6b2a80cb97423309faf1956f6defe4)
(`commands/auth.ts`, `config/auth.ts`, `config/environment.ts`,
`config/storage-paths-lite.ts`, `core/models/modelConfigResolver.ts` and the
provider presets) supplies the source inventory. The
[isolated reader regressions](../../tests/qwen/auth-status.test.ts) cover
system/user settings, JSONC, dotenv bootstrap, custom keys, overlay removal,
metadata-only token checks, excluded workspaces, privacy, deadlines and local
orientation. They establish local observation, not remote authentication.

## Orientation query costs

`listModels()` starts Qwen in the selected workspace, initializes its
stream-JSON control channel, reads `get_available_models`, and closes it. Native
configuration and provider setup can run during that process, so catalog reads
are explicit `models`-depth work, not a cheap local metadata promise. No model
prompt is submitted. The local auth-status reader observes configuration only;
it cannot confirm a usable provider login.

## Reader environment

Installation, authentication status and model listing accept `env` using the
session overlay rules.
Discovery evaluates the QWEN installation directory variables and home
fallback from that map on each call; the model query uses it too. See
[reader environments](../spec/orientation.md#environment).
