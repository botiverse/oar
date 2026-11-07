# Runtime version check: 2026-11-07

The follow-up checks file reads and searches on the same eleven runtimes,
plus Pi's RPC execution. Linux, local model providers, disposable projects;
Qoder is the native replay control on **1.1.81 only**. This is not execution
validation of current Qoder 1.1.84, macOS, Windows or a paid provider.
No interface was added.

## Actual file operations

Each successful run reads `audit.txt` and searches for `BEFORE`. The file
contains `BEFORE actual-file-evidence`; only the file contains that second
marker. The probe requires the native tool result received by the model to
contain it, not merely a successful tool status. Qoder's replay control
checks its native tool result content instead. All 24 operations passed.
The [selected records](results/files) retain native inputs, projected events,
results, runtime versions and hashes of the full local recordings.

| Runtime | Version | Read | Search | Added mappings |
|---|---|---|---|---|
| Claude | 2.1.319 | `Read {file_path}` | `Bash {command}` | None |
| Codex | 0.167.0 | `exec_command`, projected as `commandExecution` | Same, with `rg` | None |
| Grok | 1.0.77 | `read_file {target_file}` | `grep {pattern,path}` | `read_file`, `grep` |
| Kimi | 2.5.2 | `Read {path}` | `Grep {pattern,path,output_mode}` | `Read`, `Grep` |
| OpenCode | 2.2.5 | `read {path}` | `grep {pattern,path}` | None |
| Qwen | 0.26.9 | `read_file {file_path}` | `grep_search {pattern,path}` | `read_file`, `grep_search` |
| Qoder | 1.1.81 replay | `Read {file_path}` | `Grep {pattern,path,output_mode}` | `Read`, `Grep` |
| CodeBuddy | 2.181.0 | `Read {file_path}` | `Grep {pattern,path,output_mode}` | `Read`, `Grep` |
| Antigravity | 1.5.2 | `read_file {Path}` | `run_command {CommandLine,...}` | `read_file` |
| DSH | 0.2.2-rc.1 | `read {file_path}` | `grep {pattern,path}` | `read`, `grep` |
| Pi SDK / RPC | 1.5.0 | `read {path}` | `bash {command}` | None |

The input on a later update is authoritative. Grok adds `variant` and
optional search fields; Kimi and OpenCode supply arguments after the opening
frame; CodeBuddy supplies intermediate whole input objects before the final
one. The regression replays each recorded ACP input through the real shared
projection before classifying its last value.

There is no search category inferred from shell text. Codex, Antigravity,
Pi and the successful Claude control remain `run_command`. Only observed
file-tool names are added. Other names, including untested glob tools on
these newly mapped runtimes, remain `other`.

## Search detail and the Claude boundary

The previous `detail` order chose the path before the pattern. Actual search
inputs above contain both; before the fix a search for `BEFORE` in a project
was displayed as just the project path. Search now prefers nonempty
`pattern`, then `query`, then its previous fallback order. File paths still
act as scope; all other categories retain their existing order. No new field
is introduced. The two changed OpenCode snapshots show only `grep` and
`glob` changing from `<path>` to `<pattern>`; an existing Pi grep assertion
likewise changes from its path to its pattern.

No existing Claude Grep recording was found in the replay fixtures. Direct
controls on [2.1.319](results/files-controls/claude-2.1.319.json) and
[2.1.309](results/files-controls/claude-2.1.309.json) first selected `Grep`
with `ToolSearch`, which returned no match. Calling `Grep` then explicitly
failed as unavailable in that session, directing the caller to Bash. These
are refusal evidence, not proof of a successful Claude Grep execution or a
claim about all Claude sessions. Bash search passed on 2.1.319. The existing
Claude Grep classification is retained; the successful searches on the other
runtimes establish the detail-order bug independently.

## Codex collaboration input

The original real `wait_agent` recording contains native
`tool: "wait"` and `prompt: null`. Earlier parent/peer wait recordings contain
`tool: "wait"` without `prompt`. Previously neither became projected input.
The adapter now serializes just the present native `tool` and `prompt`
fields; explicit null or empty values are retained. With neither field,
input stays absent. It does not infer recipients or prompt text from child
ids, rename the `collabAgentToolCall` category, or turn operation completion
into child task completion. `classifyTool` continues to report `subagent`.
The existing [original recording](results/collaboration.json) is unchanged.
[New native frames](results/collaboration-input.json) show the added input.

A real Codex vendor regression spawns a child with a local model, calls
`wait_agent`, checks the native item and exact projected start/end events.
Controlled unit cases separately cover a present string prompt, missing
fields, empty values and unrelated fields; they do not claim that those
variants were all observed in this wait run.

## Reproduce

From the repository root, set each `OAR_<RUNTIME>_BIN` to the version above,
use Node 24 and `TMPDIR=/tmp`, and unset `PI_PACKAGE_DIR`, `TMP`, `TEMP` if
they point at a different SDK or worktree. Pi uses the pinned 1.5.0 SDK.

```sh
pnpm tsx experiments/tool-activity-audit/probe.ts qwen /tmp/tool-files files
# Repeat for claude, codex, grok, kimi, opencode, codebuddy,
# antigravity, dsh, pi and pi-rpc.
OAR_QODER_BIN=/path/to/qoder-1.1.81 pnpm tsx experiments/tool-activity-audit/qoder.ts /tmp/tool-files files
python3 experiments/tool-activity-audit/select.py /tmp/tool-files /tmp/selected-files files
AUDIT_CLAUDE_GREP=1 pnpm tsx experiments/tool-activity-audit/probe.ts claude /tmp/claude-grep files
# The last command is the refusal control and is expected to fail its success assertion.
pnpm tsx experiments/tool-activity-audit/collab.ts /tmp/collaboration-input
OAR_TEST=codex-aimock pnpm vitest run sea-trial/vendor/codex-collaboration.vendor.test.ts
```

Before the product changes, the focused regression run failed 12 cases,
including the real wait input, read mappings and search detail. Validation
of the final revision is recorded in the pull request. Existing unrelated
native fields and output handling are unchanged.
