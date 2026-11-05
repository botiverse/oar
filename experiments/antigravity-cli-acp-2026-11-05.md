# Antigravity: native CLI ACP migration

OAR now starts `agy acp` from CLI 1.5.0 instead of the separate
`agy_acp_server` archive. The public runtime id stays `antigravity`.
The new native interface supports input inside the active model loop, but
several old-service assumptions no longer hold. The adapter and its
capability declarations follow the measured CLI behavior.

## Runtime and method

- Date: 2026-11-05; Linux x64.
- Native CLI: 1.5.0, from the official Linux amd64 manifest. Archive SHA-512:
  `e6031f850929210705d8c2393a5665b82b8c3b19684a6d3c556cafa31f26f77acbf164dfee96ca84a5ae7670ac0cc238a974c981c517b269194bdccff271cbd5`.
- Each native control has a fresh HOME/GEMINI_HOME, local scripted Gemini
  endpoint and synthetic key. No real account login or inference.
- Product launch: `agy acp --dangerously-skip-permissions --process-per-session`.
  The direct probe also disables telemetry. Only the fixture disables auto
  updates; the product retains the CLI's native behavior.
- [Selected native responses and provider fields](antigravity-cli-acp-2026-11-05/selected.json)
  retain the comparison. Temporary homes, conversation ids and synthetic
  token digests are replaced by placeholders. Full wire/provider captures
  are produced locally by the script and are not committed. The
  [no-worker initialization control](antigravity-cli-acp-2026-11-05/without-workers.json)
  records the absence of HTTP MCP capability without `--process-per-session`.

Public references: [native ACP](https://antigravity.google/docs/cli/acp),
[CLI installation](https://antigravity.google/docs/cli),
[official shell installer](https://antigravity.google/cli/install.sh),
[official PowerShell installer](https://antigravity.google/cli/install.ps1),
[CLI settings](https://antigravity.google/docs/settings?tab=cli),
[CLI MCP](https://antigravity.google/docs/mcp?tab=cli), and
[public changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md).
The protocol and provider assertions below come from native execution, not
from treating the changelog as a behavioral guarantee.

## Observed changes and OAR decisions

| Surface | Native CLI 1.5.0 evidence | OAR decision |
| --- | --- | --- |
| Discovery | Plain `--version` is `1.5.0`; pre-1.5 CLI can print help and exit successfully for unknown `acp`. | Discover `agy`, require CLI release at least 1.5.0, refuse old server overrides. |
| Permissions | Modes `default`, `accept-edits`, `plan`; old `yolo` absent. | Use the documented skip-permissions launch flag; no synthetic mode selection. |
| Authentication/configuration | CLI settings live in `antigravity-cli`, not the old `antigravity-acp` store. | Reuse native CLI config/login; no automatic credential migration or typed login implementation. |
| MCP transport | With per-session workers, both stdio and HTTP tools execute successfully. | Include `--process-per-session` so native HTTP MCP capability is available. |
| Steer | The second prompt reaches the next provider request before the first loop's final answer; original prompt RPC answers early. | Expose steer, supersede the earlier prompt when deciding turn completion. |
| Model/effort | Config id is `thought_level`. Omitted model on resume resets to the CLI default; reapplying Flash plus high reaches the provider as `HIGH`. | Preserve native readback; callers pass the full intended config again on resume. |
| Append | Fresh append arrives; a new resume append replaces it; omission removes it. | Keep capability-gated native append. No broader resume/compaction declaration is added. |
| Tool denial | `_meta.antigravity.disabledTools: ["run_command"]` still leaves `run_command` in provider tools. | Refuse all non-empty `disallowedTools` before launch. |
| Extra directories | Extra roots appear, but can replace command cwd. | Keep `additionalDirectories` refused; reason updated to the actual CLI violation. |
| Resume cwd | Resume naming another cwd retains the saved native directory. | Use native listing to reject a different cwd before prompting. |
| Missing resume | Missing id returns generic `-32603`. | Map to `SessionNotFoundError` only after a complete list independently proves absence. |
| MCP credentials | Synthetic env/header values persist in conversation DB/WAL after close. | Keep `mcpServerCredentials` refused. |
| MCP tool changes | Connected HTTP client never lists again after a tool-list change; next request offers old tools. | Declare `mcpToolsListChanged: "none"`, replacing the old service's `full`. |
| Close | Native close is advertised and responds successfully. | Use existing ACP close/disposal path and process ownership. |
| Manual compaction | `/compact` is advertised, but structured completion/identity has not been verified. | Keep typed compact absent; update the reason rather than guessing completion from text. |

### Steer needs the newest prompt response

The direct `steer` control holds the first provider response, sends a second
ACP prompt, and observes the first prompt's `end_turn` reply **before** the
barrier is released. After release, the first provider call runs an MCP
echo, and the second provider call contains both its tool result and the
steered input. That call returns the final answer. There are two main model
requests, not two separately completed OAR turns.

The vendor regression observes the early reply synchronously: status must
remain running, no `turn_ended` may exist, and a new prompt must reject busy.
After releasing the provider barrier, it requires exactly one completed
turn and verifies the second request's input and tool result. This is why
`steerSupersedesPrompt: true` is required, rather than just exposing a second
native prompt as a control method. The separate title-generation request is
identified from its native system instruction and excluded from main-model
counts.

### Resume settings must be reapplied

The raw provider control starts with `gemini-3.8-flash`, low and
`APPEND_FRESH`. On resume without a model, native configuration returns to
`gemini-3.1-pro`; setting high on that family uses a thinking budget of -1,
not a Flash `thinkingLevel`. Reapplying `gemini-3.8-flash` and high produces
`thinkingLevel: "HIGH"`. A final resume without either option returns to
the CLI default model and low budget. Append changes and omission are
visible in the actual system instruction, independently of config readback.
The vendor test compares low and high only after explicitly selecting the
same family on both opens. It does not hide the default-model reset.

### Extra roots violate the primary directory contract

The `cwd-roots` control starts the CLI itself in `z-original` and creates a
session with that same cwd. With no extras, native `session/list`, the
provider's `Command Working Directory` and an actual `run_command` running
`pwd` all report `z-original`. Add sibling `a-extra` and all three report
`a-extra`, while both directories appear as active workspaces. This is a
native change of command location, not just misleading list metadata.
OAR cannot promise its primary cwd in that configuration and refuses it.

A separate native resume control names another cwd but continues executing
in the original one. The OAR regression checks that the guard rejects such
a change without any provider request, then confirms same-cwd resume still
works. Unknown-id mapping includes negative list/error tests so a generic
internal error never becomes fabricated absence evidence.

### MCP behavior is measured at the provider and server

Session entries expose `mcp_<server>_<tool>` and require `toolSummary`.
Global user entries stay behind `call_mcp_tool {ServerName, ToolName,
Arguments}`; that wrapper rejects an extra `toolSummary`. Native tests
verify both forms, stdio and HTTP, session-over-user name precedence,
non-clashing user entries and unchanged user configuration files.

The dynamic-list test first proves connection and an initial tools/list,
then changes the served tools. On 1.5.0 there is no second list, and the
next provider request retains the opening tool set. It asserts the runtime's
`none` declaration against both facts.

Credential persistence is a direct-native control with a synthetic marker,
not an OAR session that bypasses its guard. The marker appears in
`.gemini/antigravity-cli/conversations/<session-id>.db` and its WAL after
native close. OAR still refuses credential-bearing entries before launch.
The move to a CLI-owned data directory does not fix that behavior.

## Repeat the controls

Install the documented CLI, then point these commands at its absolute path:

```sh
OAR_AGY_BIN=/absolute/path/to/agy \
  OAR_PROBE_DIR=oar-trial-run/agy-acp-migration \
  pnpm tsx experiments/agy-acp-migration.ts
OAR_TEST=antigravity-aimock OAR_ANTIGRAVITY_BIN=/absolute/path/to/agy \
  pnpm sea-trial
OAR_TEST=antigravity-aimock OAR_ANTIGRAVITY_BIN=/absolute/path/to/agy \
  pnpm vitest run sea-trial/vendor
```

The probe writes full wire/provider JSON and `selected.json`. Set
`OAR_PROBE_CASE` to `steering`, `settingsAndResume`, `userMcp` or `cwdRoots`
for one control. `OAR_PROBE_WORKERS=0 OAR_PROBE_CASE=cwdRoots` repeats the
no-worker initialization/directory control without attaching MCP. Local raw files can contain temporary paths and synthetic
configuration, so publish the selected fields rather than entire captures.

The official-installer smoke test is a separate command, because it
**downloads and runs the vendor's installer** in an empty temporary HOME:

```sh
pnpm tsx experiments/agy-install-smoke.ts
```

It verifies installation, discovery with `~/.local/bin` off PATH, and an
idempotent second call. It removes the temporary HOME afterwards. On this
Linux run, installation reported checksum verified, OAR found version 1.5.0,
and the second call returned `already_installed`. Native Windows/macOS
installation was not run; path-selection unit cases are not native evidence.

## Validation and limits

The adapter's local native behavior suite passed 17 cases, with two
capability skips. The full native vendor set passed 12 cases, including
model listing, steering and resume guards.
The tests use real CLI processes and tools with scripted model responses.
No personal-account inference, child-attribution measurement, native
Windows/macOS run, usage guarantee or compaction-completion mapping is
claimed. Existing completed-looking provider failures remain honest native
observations.

Two negative controls failed as intended: removing prompt supersession made
the held-loop test observe idle instead of running; changing the MCP
declaration back to full failed on the absent second tools/list. Both
mutations were reverted.

The default unit/fake suite covers the CLI launch line, version floor,
Windows/POSIX discovery paths, model selectors, native close, option
refusals, complete/incomplete session-list classification and declarations.
The final commit gate and package checks are recorded in the pull request.

## Host migration and release-note draft

- Install agy CLI 1.5.0 or newer. `OAR_ANTIGRAVITY_BIN`, if set, must name
  `agy`/`agy.exe`; remove overrides pointing at `agy_acp_server`. OAR also
  discovers the official install directory when it is absent from PATH.
- Use the CLI's existing login/configuration, or run its documented
  `agy acp --login` flow. OAR does not copy the separate service's tokens or
  conversation database; reuse of those old conversations is unverified.
- Antigravity now exposes `steer`, so `deliver`/`steerOrQueue` can use the
  active native loop. Earlier prompt replies no longer release that loop.
- Pass model, effort, append and MCP settings on each resumed open. A
  changed cwd is rejected instead of silently continuing elsewhere.
- Non-empty tool-denial lists are now rejected because the new native CLI
  ignores the old filter. MCP credential-bearing entries and extra
  directories remain rejected for measured native limitations.
- MCP tool titles for session entries now use `mcp_<server>_<tool>`;
  dynamic tool-list changes are declared `none`. Hosts should inspect the
  declaration rather than assuming the retired service's behavior.
- Installation plans and update checks follow the native CLI. OAR login,
  logout, auth-status and upgrade remain unimplemented; no package version
  or release tag is changed by this migration.
