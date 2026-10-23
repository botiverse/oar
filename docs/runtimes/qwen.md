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

## OAR mapping

`qwenRuntime` is in `defaultRuntimes` and available separately from
`@botiverse/oar/runtimes/qwen`. Install the vendor executable with
`npm install -g @qwen-code/qwen-code`; `OAR_QWEN_BIN` selects another copy.
The CLI requires Node 22 or newer; OAR itself requires Node 24 or newer.

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
| Login | No `login` member. Native `qwen auth` was removed. Configure a provider externally, for example OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL. No OAR login prompt or browser flow. |
| Other surfaces | No service tier or session-name setting; no account quota, inventory, installer/updater, live configure or context breakdown mapping. |

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
  tool denial, missing resume and native extension-lock failure.
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
