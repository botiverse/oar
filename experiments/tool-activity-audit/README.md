# Cross-runtime tool activity audit

2026-11-07, Linux x64, Node 24.19.0. Base `db9a3fce` (OAR 0.92.0).
The model endpoints and MCP server were local fixtures; no account or paid
inference was used. These are observations of real runtime processes, not
mock runtime events. Pi includes both its SDK and subprocess RPC paths.
The tables and selected records describe that base. The
[follow-up](#follow-up-decisions-and-input-fix) records the input fix and
the decisions made after the audit.

## Conclusions

1. Tool names and input timing differ materially. Hosts must consume
   `tool_call_input` as well as the start, and cannot recover all arguments
   from that typed string at the audited base. Shared ACP treated objects with a
   `text` property as display text, losing the other fields from the typed
   input. The original object remains in `frame.native`.
2. Native categories and paths already exist on ACP, but are not separate
   fields of OAR's tool event. Codex has typed item variants and file changes.
   Other tested protocols carry paths in arguments without a separate
   category. This audit adds no category, path or readiness API.
3. Opening a session is not a universal MCP readiness barrier. Codex and
   CodeBuddy reached their first model request before the delayed tools list
   returned. Codex and Grok have explicit native startup notifications;
   Claude, Qwen and the Qoder replay control report a connected snapshot.
4. Native Codex rejects steering a review turn. OAR reports
   `rejected / runtime_refused`, not acceptance. The probe also found a turn
   identity distinction described below; no review API or control change is
   introduced here.
5. The authorized Codex fix is limited to projecting `collabAgentToolCall`
   start/end as existing tool lifecycle events. A real `wait_agent` call
   demonstrated the gap. File edits already carried `changes` at both start
   and completion in this run, so no completion-input fallback was added.

## Tools and inputs

[Exact input table](inputs.md) lists start input, each complete input update,
MCP identity fields, native category and locations for every tested call.
[Selected JSON](results/) retains these values and relative readiness times;
`nativeInputs` and `nativeDetails` are native evidence, not newly projected
fields. `<project>` and `<probe>` replace disposable paths. A raw-log SHA-256
identifies each local source file; raw model requests and system prompts are
not published.

| Runtime/version | Command / edit / MCP `tool` | Input delivery | Separate native category/path evidence |
|---|---|---|---|
| Claude 2.1.319 | `Bash` / `Edit` / `mcp__audit__echo` | Start has no input; later `tool_call_input` contains JSON | No category in observed tool-use blocks; `file_path` in arguments |
| Codex 0.167.0 | `commandExecution` / `fileChange` / `mcpToolCall` | Full input at start | Item type; `commandActions`; `changes[].path` and change kind |
| Grok 1.0.77 | `run_terminal_command` / `search_replace` / `use_tool` | Initial JSON, then tagged native argument object | ACP execute/edit/other; `_meta["x.ai/tool"]`; edit locations and diff path |
| Kimi 2.5.2 | `Bash` / `Edit` / `mcp__audit__echo` | No initial input; later JSON, except MCP becomes plain `ACTUAL` | ACP execute/edit/other; edit locations and diff path |
| OpenCode 2.2.5 | `shell` / `edit` / `execute` | Partial `{cwd}` or `{}` at start; later JSON | ACP execute/edit/other; command cwd location and edit locations/diff |
| Qwen 0.26.9 | `run_shell_command` / `edit` / `tool_call` | No initial input; later JSON | No separate category in tool-use blocks; `file_path` in arguments |
| Qoder 1.1.81 control | `Bash` / `Edit` / `mcp__audit__echo` | Full JSON at start | No separate category in assistant tool-use blocks; `file_path` in arguments |
| CodeBuddy 2.181.0 | `Bash` / `Edit` / `mcp__audit__echo` | `{}` then partial/complete JSON; MCP becomes plain `ACTUAL` | ACP initially other, then execute/edit; edit locations/diff |
| Antigravity 1.5.2 | `run_command` / `edit_file` / `mcp_audit_echo` | Full command/edit JSON at start; MCP becomes plain `ACTUAL` | ACP execute/edit/other; edit locations/diff |
| DSH 0.2.2-rc.1 | `bash` / `edit` / `mcp__audit__echo` | Full JSON at start | Native tool/call name and argument string; `file_path` in arguments |
| Pi 1.5.0 SDK and RPC | `bash` / `edit` / `mcp__audit__echo` | Full JSON at start | Native tool_execution_start name/args; `path` and edit array in arguments |

Claude and Qwen also emit `tool_call_input_delta` while the JSON arguments
stream. The table retains the subsequent complete input replacements; those
are not deltas to append. CodeBuddy can replace its input several times with
partially parsed objects before the complete one.

Only Codex's typed MCP start supplies `server: "audit"` and
`toolName: "echo"` in this sample. Other runtimes preserve the names above,
without splitting them into those fields. Grok's completed raw output also
reports `server_name`/`tool_name`. OpenCode invokes MCP through Code Mode:
`execute` receives code, and completed native metadata reports
`toolCalls: [{tool: "audit.echo", status: "completed", input: {text: "ACTUAL"}}]`.
There is no separate OAR MCP tool lifecycle for that nested execution.
Qwen's `tool_call` is a native discovery/invocation tool, not an OAR rename.

For Kimi and CodeBuddy, native `{text: "ACTUAL"}` becomes typed input
`ACTUAL`; for Antigravity `{text: "ACTUAL", toolSummary: "Audit echo"}` loses
both its JSON shape and the summary. This follows `detail()`/`textContent()`
in [shared ACP projection](../../packages/oar/src/shared/acp/projection.ts).
At the audited base that helper also truncated input at 10,000 characters;
large-input behavior was not tested in the original runs. The follow-up
below fixes both losses without changing output previews.

Every selected edit changed `BEFORE\n` to `AFTER\n`; every selected MCP call
reached the server and returned `AUDIT_MCP:ACTUAL`. CodeBuddy's initial
`printf 'AUDIT_COMMAND\n'` failed with native terminal execution reporting
`spawn ... ENOENT`. A separate `pwd` control succeeded, and its actual input
is shown in the table. [The failed command](results/codebuddy-command-control.json)
is retained; it is not counted as successful execution or diagnosed as a
Windows issue.

Qoder is explicitly a coverage boundary: the account-free native replay
control is 1.1.81. It executes real tools/MCP but consumes local scripted
replies instead of an HTTP provider. Installed 1.1.84 was not execution-tested
here; 1.1.82 and later removed the replay consumption path. The
[prior custom-provider investigation](../qoder-deepseek/README.md) and
[official custom-model instructions](https://docs.qoder.com/cli/custom-models)
do not establish an arbitrary local provider for the current account-free
path. This row is not a claim about current Qoder execution or streaming.

## MCP readiness

`server.ts` delays `tools/list` for two seconds. The first prompt is submitted
immediately after OAR open. The fixture records actual MCP request/response
order and the local provider records its first primary inference request.
Auxiliary title/summary requests do not count. After that first turn the
probe explicitly waits for the tools list before testing tool use; that
probe wait is not attributed to OAR or the runtime.

Milliseconds from beginning OAR open in one run:

| Runtime | Open returned | Tools list returned | First primary model request | Native signal visible in OAR raw records |
|---|---:|---:|---:|---|
| Claude | 66 | 2779 | 2945 | `system/init.mcp_servers[].status = connected` |
| Codex | 146 | 2201 | 1313 | `mcpServer/startupStatus/updated`: starting, then ready |
| Grok | 188 | 2244 | 2271 | `_x.ai/mcp/server_status: ready`, init_progress, mcp_initialized |
| Kimi | 1768 | 3690 | 3763 | No server-specific readiness frame observed |
| OpenCode | 3566 | 3554 | 3662 | No server-specific readiness frame observed |
| Qwen | 1787 | 4225 | 4647 | `system/init.mcp_servers[].status = connected` |
| Qoder control | 10743 | 8924 | No HTTP model request | `system/init.mcp_servers[].status = connected`; native replay starts after open |
| CodeBuddy | 2886 | 4774 | 3582 | No server-specific readiness frame observed; model catalog has `WaitForMcpServers` |
| Antigravity | 2555 | 2519 | 2633 | No server-specific readiness frame observed |
| DSH | 4737 | 4712 | 4948 | Bridge open waits for native MCP plugin activation |
| Pi SDK | 185 | 2261 | 2434 | No server-specific readiness event observed |
| Pi RPC | 1223 | 3259 | 3328 | No server-specific readiness event observed |

This is a delayed-success observation, not a universal guarantee for failed,
slow or dynamically added servers. “No frame observed” does not mean the
runtime has no internal status or command-line query. No common OAR
MCP-ready event is currently projected from the signals in this table.
CodeBuddy's `WaitForMcpServers` is model-facing; its catalog description is
not proof that the host's initial prompt waits for it.

DSH is distinct: the bridge already awaits `loader.await()`, checks the
requested `loader.entries()` and requires each native fiber's ACTIVE state
([implementation](../../packages/oar/src/runtimes/dsh/bridge.ts),
[MCP contract](../../docs/runtimes/dsh.md#session-mcp-servers)). `dsh/ready`
and `dsh/opened` are OAR bridge frames, not native MCP status notifications.
Pi uses the native `createMcpExtension`/`registerMcpServer` path, whose
`session_start` connects servers. The measured first prompt follows that
work; it is not inferred from `open` returning
([Pi mapping](../../packages/oar/src/runtimes/pi/mcp.ts)).

## Codex review and collaboration

OAR has no `review/start` method. [The probe](review.ts) uses a transparent
process wrapper that replaces just the first outgoing `turn/start` with
native `review/start`, then forwards all replies and notifications unchanged.
It holds the local model response while calling OAR `steer`. Thus it tests
OAR control behavior against a real review, not a literal `/review` prompt.

- With OAR's unmodified steer request, native review notifications supplied
  a different turn id from the one returned by `review/start`; native rejected
  the steer with an expected-active-turn mismatch. OAR returned
  `rejected`, `code: runtime_refused`, and a `not_steerable:` reason.
- A second control changes only `expectedTurnId` on the wire to the id returned
  by `review/start`. Native then rejects with JSON-RPC `-32600`, message
  `cannot steer a review turn`, and
  `data.codexErrorInfo.activeTurnNotSteerable.turnKind = review`. OAR again
  returns `runtime_refused` with that reason. The typed response does not
  expose that native structured error as a distinct rejection code.
- The subsequent ordinary turn accepts steer in both runs. Both review and
  ordinary turns then complete. No refusal is inferred just from text.

[Unmodified OAR control evidence](results/review-oar.json),
[matching-id native control](results/review-matched.json), and the
[0.167.0 protocol source](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/protocol/src/protocol.rs)
record the distinction. Review refusal is not changed by this PR.

`collab.ts` enables native multi-agent v2, starts one fixture child and calls
`wait_agent`. The native wait creates `collabAgentToolCall` with inner
`tool: "wait"`, status inProgress then completed; both frames previously
had no tool events ([before-fix evidence](results/collaboration.json)).
The fix adds that native item type to the existing tool projection. It does
not treat spontaneous `subAgentActivity` task notifications as tool calls,
change task status or rename tools. Native completed/failed status maps to
existing ok/failed results. No input is synthesized from other fields.

A separate existing stop-task vendor test also passed with real v2 children.
An initial control with multi_agent_v2 disabled offered no spawn tool and did
not establish a legacy collaboration path; it is not counted as native proof.
The committed replay test additionally uses earlier real parent/peer wait
frames to pin lifecycle ownership. It fails before the mapping is added.

## Reproduction and validation

From the repository root, point `OAR_<RUNTIME>_BIN` at the version under test.
Use Node 24 and an isolated `TMPDIR=/tmp`; unset `PI_PACKAGE_DIR`, `TMP` and
`TEMP` when they point into an agent worktree. These fixtures configure local
providers and disposable homes. Pi uses the repository's pinned 1.5.0 SDK.

```sh
pnpm tsx experiments/tool-activity-audit/probe.ts codex /tmp/tool-audit full
# Repeat for claude, grok, kimi, opencode, qwen, codebuddy,
# antigravity, dsh, pi and pi-rpc with their native binary overrides.
OAR_QODER_BIN=/path/to/qoder-1.1.81 pnpm tsx experiments/tool-activity-audit/qoder.ts /tmp/tool-audit
pnpm tsx experiments/tool-activity-audit/review.ts /tmp/review-oar
AUDIT_MATCH_REVIEW=1 pnpm tsx experiments/tool-activity-audit/review.ts /tmp/review-matched
pnpm tsx experiments/tool-activity-audit/collab.ts /tmp/collaboration
python3 experiments/tool-activity-audit/select.py /tmp/tool-audit /tmp/selected
```

All platform observations in this report are Linux-only. macOS, Windows,
real providers, failure readiness and runtime versions beyond those listed
are not covered. Validation results are recorded in the pull request.

## Follow-up decisions and input fix

ACP `rawInput` is argument data. Objects and arrays are serialized whole,
even when they contain `text`; strings remain verbatim. There is no
10,000-character input cap, because clipping JSON makes its fields
unparseable and can hide a later update that differs only beyond the cap.
Output preview extraction and its cap are unchanged. A host's existing
record-retention budget remains separate. Historical selected records above
retain the original observations, not newly generated expectations.

The public `classifyTool` utility uses these recorded tool names and fields:

| Runtime | Added classification / fields |
|---|---|
| Qwen | `run_shell_command`: command; `edit`: file_path; `tool_call`: MCP only when input.name begins `mcp__` |
| Qoder | `Bash`: command; `Edit`: file_path, evidenced by the 1.1.81 replay control |
| CodeBuddy | `Bash`: command; `Edit`: file_path |
| Antigravity | `run_command`: CommandLine and toolSummary; `edit_file`: Path; direct `mcp_<server>_<tool>` names: MCP |
| DSH | `bash`: command and description; `edit`: file_path |
| Grok | `search_replace`: edit using file_path; `use_tool`: MCP |
| Kimi | `Edit`: edit using path |
| Codex | `collabAgentToolCall`: subagent operation, with no invented arguments or child completion |

Unrecorded names remain `other`; OpenCode `execute` is still `other` because
the same tool executes plain code as well as MCP calls. Existing `mcp__`
name handling remains. The regression reads the selected actual inputs,
including the ACP native objects before projection; large-input cases check
both JSON parsing and changes after the former limit.

For a native large-input control, run the existing probe with
`AUDIT_LARGE_INPUT=1` to send a 12,000-character MCP argument, then run
`pnpm tsx experiments/tool-activity-audit/fidelity.ts <probe.json>`. The
checker compares each projected input to that exact frame's `rawInput`,
including start and later replacements, without publishing full payloads.

[Linux native controls](results/input-fidelity.json) passed on Grok 1.0.77,
Kimi 2.5.2, OpenCode 2.2.5, CodeBuddy 2.181.0 and Antigravity 1.5.2. All
38 projected inputs matched their native source, and each server received
the full 12,000-character MCP argument once. The longest projected input
was 12,072 bytes. The same checker rejects the pre-fix CodeBuddy recording
where the native `{text: "ACTUAL"}` became plain `ACTUAL`.
[Replay regressions](../../tests/replay/tool-activity-audit.test.ts) use the
original audit values; no existing snapshot was rewritten for the fix.

MCP readiness remains a raw native observation. This audit does not justify
a common readiness event or an OAR waiting policy; in particular the Codex
startup notifications remain available as raw frames. The signals and
measured ordering for other runtimes remain as recorded above. Review steer
keeps the existing `runtime_refused` result; no review API or new rejection
code is added.
