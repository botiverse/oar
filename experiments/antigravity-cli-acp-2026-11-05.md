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
| Authentication/configuration | CLI settings live in `antigravity-cli`, not the old `antigravity-acp` store. | Preserve both native stores; no credential migration or consumer login control. Follow the vendor FAQ and use provider API keys. |
| MCP transport | With per-session workers, both stdio and HTTP tools execute successfully. | Include `--process-per-session` so native HTTP MCP capability is available. |
| Steer | The second prompt reaches the next provider request before the first loop's final answer; original prompt RPC answers early. | Expose steer, supersede the earlier prompt when deciding turn completion. |
| Model/effort | Config id is `thought_level`. Omitted model on resume resets to the CLI default; reapplying Flash plus high reaches the provider as `HIGH`. | Preserve native readback; callers pass the full intended config again on resume. |
| Append | Fresh append arrives; a new resume append replaces it; omission removes it. | Keep capability-gated native append. No broader resume/compaction declaration is added. |
| Tool denial | `_meta.antigravity.disabledTools: ["run_command"]` still leaves `run_command` in provider tools. | Refuse all non-empty `disallowedTools` before launch. |
| Extra directories | Extra roots appear, but can replace command cwd. | Keep `additionalDirectories` refused; reason updated to the actual CLI violation. |
| Resume cwd | Resume naming another cwd retains the saved native directory. | Require positive saved-cwd confirmation before any resume/load; reject different or unknown cwd. |
| Unlisted resume | Unprompted sessions are unlisted but resumable; load also succeeds for a genuinely absent id. | Do not infer missing history, or fall back to load. Both unlisted cases receive the same cwd refusal. |
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
native prompt as a control method. Fake-transport regressions also hold the
replacement response after the early `end_turn`, then settle it with success,
RPC failure or cancellation. The replacement owns the final outcome in all
three; an old success cannot turn a failed or aborted replacement into a
completed turn. Conversely, a rejected steer that arrives before the original
prompt has replied does not own the original turn's outcome. The new ordering
regression requires that original prompt's later success to remain completed. The separate title-generation request is
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

### Model notifications must settle before effort

The original Ubuntu CI failed the resumed effort readback: high was requested
but low was observed. An independent review reproduced an answer of high,
then an update of high, then the older model-switch update of low in 1 of
150 native pairs. That failing run did not retain a provider request, so its
actual inference setting is unknown.

This machine did not reproduce that spontaneous order in 450 direct-native
pairs (150 serial, 300 with five sessions in parallel). To inspect the
provider without inventing a native reproduction, a separate **delivery-only
control** held the first native configuration notification and released it
after the second. It changed neither requests nor native message contents.
All 10 delivered update pairs were high then low, while all 10 actual Gemini
requests carried `thinkingLevel: "HIGH"`. This demonstrates that stale
readback need not describe the native inference setting; it does not prove
what the original failing run used.

The fix waits, within the existing request deadline, for the model answer
and its own `config_option_update` before setting effort. It then requires
both the effort answer and notification to confirm the requested value.
No retry, quiet-time heuristic or substituted value is used. Missing or
contradictory confirmation refuses construction. With native ordered
requests, 150 additional pairs all ended with high; a separate 10-prompt
control also observed `HIGH` at the provider in every request.
[Selected counts and provider fields](antigravity-cli-acp-2026-11-05/effort-order.json)
distinguish direct execution from the controlled delivery change.

Protocol regressions delay the model update, omit each required notification,
and contradict the effort answer. They require both notifications to be
recorded before open returns and retain the requested high assertion.

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
works after the saved session appears in the native list.

The [unprompted-session control](antigravity-cli-acp-2026-11-05/unprompted-resume.json)
creates and closes a session without a prompt. `session/list` omits it, yet
both resume and load reopen its original id, ignore a different requested
cwd, and return no cwd field. The next provider request names the original
directory and native `pwd` executes there. With a genuinely absent valid
UUID, resume fails with generic `-32603`, while load succeeds with that
requested id. This does not prove that history exists or was created.

OAR therefore refuses an unknown saved cwd before either native request,
with `UnsupportedOptionError("cwd", ...)`, for unprompted and absent ids
alike. Missing list support, missing/empty cwd, malformed pages and cursor
loops cannot bypass that guard. The same positive-evidence rule applies to
Kimi and OpenCode, which also retain native cwd. Listing authentication,
process-exit and other RPC errors retain their existing failure classification
and prevent resume. They do not establish a directory mismatch or unusable
session. A listed session's generic resume error is not mapped to missing. Hosts may open a new session, but cannot infer history loss from
these refusals. Existing service history is neither migrated nor deleted.

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

### The manual multi-session probe keeps its negative cwd result

The migrated [sharing probe selection](antigravity-cli-acp-2026-11-05/shared-process.json)
uses current CLI tool schemas and separates native title-generation requests
from the main tool loop. MCP isolation passes. A synthetic child reaches the
provider, but observed tool/text frames remain under the root session id,
so attribution stays opaque.

The cwd assertion deliberately remains red: with one CLI process in the
probe home and two native sessions requesting `a` and `b`, both real commands
run in the process home. No explicit command cwd is supplied to hide this
result. Product sessions still have independent CLI processes started in
their own requested cwd; native sharing remains unadmitted. The manual
workflow retains this failed observation, rather than treating it as a
successful isolation control.

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

The separate notification-order control writes only selected values:

```sh
OAR_ANTIGRAVITY_BIN=/absolute/path/to/agy OAR_AGY_ORDERED=1 \
  OAR_AGY_ITERATIONS=10 OAR_AGY_PROVIDER_EACH=1 \
  OAR_AGY_RESULT=oar-trial-run/agy-effort-order.json \
  pnpm tsx experiments/agy-effort-order.ts
```

Omit `OAR_AGY_ORDERED` for direct unordered requests. Use
`OAR_AGY_REORDER_DELIVERY=1` instead for the explicitly modified-delivery
control; it cannot be combined with ordered requests. `OAR_AGY_CONCURRENCY=5`
opens five sessions concurrently without changing native message content.

The probe writes full wire/provider JSON and `selected.json`. Set
`OAR_PROBE_CASE` to `steering`, `settingsAndResume`, `userMcp`, `cwdRoots` or `unpromptedResume`
for one control. `OAR_PROBE_WORKERS=0 OAR_PROBE_CASE=cwdRoots` repeats the
no-worker initialization/directory control without attaching MCP. Local raw files can contain temporary paths and synthetic
configuration, so publish the selected fields rather than entire captures.

The official-installer smoke test is a separate command, because it
**downloads and runs the vendor's installer** in an empty temporary HOME:

```sh
pnpm tsx experiments/agy-install-smoke.ts
```

It verifies installation, discovery with `~/.local/bin` off PATH, and an
idempotent second call. It removes the temporary HOME afterwards. The
installer may write `~/.bashrc` and `~/.zshrc` as well as its bin/cache paths;
only bin/cache writability blocks installation. Read-only shell profiles do
not prevent the vendor installer from succeeding. Existing old official
CLI and pinned-server cases are checked before downloads, because the vendor
installer skips existing copies instead of upgrading them. They return
`unsupported` with reason `configuration`; an unpinned old PATH copy may
still yield to a supported CLI in the official install location, or be
resolved by installing there when that location is empty. On this
Linux run, installation reported checksum verified, OAR found version 1.5.0,
and the second call returned `already_installed`. Native Windows/macOS
installation was not run; path-selection unit cases are not native evidence.

## Validation and limits

The adapter's local native behavior suite passed 17 cases, with two
capability skips. The full native vendor set passed 12 cases, including
model listing, steering and resume guards.
The tests use real CLI processes and tools with scripted model responses.
These local controls ran on Linux; the CI observations below separately
cover macOS and Windows. No personal-account inference, reliable child
identity link, usage guarantee or compaction-completion mapping is claimed.
Existing completed-looking provider failures remain honest native observations.

Two negative controls failed as intended: removing prompt supersession made
the held-loop test observe idle instead of running; changing the MCP
declaration back to full failed on the absent second tools/list. Both
mutations were reverted. The review revision added six more controls: removing
supersession, ignoring a replacement error, skipping native close, bypassing
unknown-cwd refusal, closing without the advertised capability, or allowing
close failure to discard a model catalog each failed its corresponding
regression. All six mutations were reverted. Further controls cover
configuration confirmation, early rejected-steer ownership, installation
migration and version parsing. The current revision's three negative controls
remove Windows drive-prefix normalization, wrap listing failures as cwd
refusals, or accept the unsupported update notice. Each makes its targeted
regression fail. The steer control ends the original prompt directly, without
a third prompt that could mask the wrong outcome.

The default unit/fake suite covers the CLI launch line, version floor,
Windows/POSIX discovery paths, migration preflight, model selectors,
native close, option refusals and positive saved-cwd confirmation. Model
listing does not request an unadvertised close, and close failure preserves
the catalog. Disposal tests assert that an advertised close really reached
the fake native process, not just that process teardown succeeded.

Required `check` CI jobs now install CLI 1.5.0 from pinned official archives
and run native behavior and vendor tests on Linux, macOS and Windows.
SHA-512 is verified before extraction/execution; the local Linux invocation
of that same installer passed. The first three-platform CI exposed the effort
race above, a macOS `/private`
path alias, and a Windows fixture missing `USERPROFILE`. Directory comparison
uses filesystem canonicalization for aliases. A subsequent Windows run
[reported](https://github.com/botiverse/oar/actions/runs/41983739833/job/127099535734)
native saved cwd `/D:/a/oar/oar` against requested
`D:\a\oar\oar`, refusing all four prompted-session resumes. The shared
comparison now strips that URI-style drive prefix only on Windows. Unit
controls cover drive mismatch, different directories, UNC paths, literal
percent characters and unchanged POSIX paths; native vendor cases continue
to require successful resume. The isolated fixture sets both
HOME and USERPROFILE, matching the CLI's native home lookup. Linux controls
pass. The previous revision's [macOS check](https://github.com/botiverse/oar/actions/runs/41983739833/job/127099535596)
passed, including native resume. The Windows drive-prefix correction still
requires the new native CI run. The manual
sharing-evidence workflow uses the same installer and
current native tool schemas instead of the retired 1.4.5 server archive.
On the rebased release baseline, the full check passed 3,208 unit tests and
18 mock behavior cases. All 15 configured behavior backends passed; native
vendor regressions also passed for Antigravity, Kimi, OpenCode and Grok.
Build and clean package installation results are recorded in the pull request.

The final directory/error revision tests all three profiles (Antigravity,
Kimi and OpenCode) against authentication errors, generic listing errors and
worker exit, requiring the original classification and no resume/load call.
Unexpected version notices are rejected until native evidence establishes a
supported form. Separate follow-ups cover rejected-steer/natural-response
intersection and accepted-steer worker exit (task #176), and a stale
configuration update arriving before the correct one (task #177). The
natural-response and stale-update findings currently have fake-agent evidence
only; they are not claimed as native reproductions or fixed here.

## Host migration and release-note draft

- Install agy CLI 1.5.0 or newer. `OAR_ANTIGRAVITY_BIN`, if set, must name
  `agy`/`agy.exe`; remove overrides pointing at `agy_acp_server`. OAR also
  discovers the official install directory when it is absent from PATH.
- Use provider API keys under the [vendor's account policy](../docs/runtimes/antigravity.md#process-ownership-installation-and-account-usage).
  Consumer login controls remain deliberately absent. OAR leaves the old
  service's credential and conversation stores intact, without migrating
  them; unconfirmed old ids receive a cwd refusal, not an invented missing
  history error.
- Antigravity now exposes `steer`, so `deliver`/`steerOrQueue` can use the
  active native loop. Earlier prompt replies no longer release that loop.
- Pass model, effort, append and MCP settings on each resumed open. A
  changed or unknown saved cwd is rejected before resume. Kimi and OpenCode
  likewise now require positive saved-cwd evidence; list absence does not
  become `SessionNotFoundError`.
- Non-empty tool-denial lists are now rejected because the new native CLI
  ignores the old filter. MCP credential-bearing entries and extra
  directories remain rejected for measured native limitations.
- MCP tool titles for session entries now use `mcp_<server>_<tool>`;
  dynamic tool-list changes are declared `none`. Hosts should inspect the
  declaration rather than assuming the retired service's behavior.
- Installation plans and update checks follow the native CLI. The new
  `configuration` installation refusal means an old official executable or
  a pinned missing location needs manual correction; no download runs.
  OAR exposes no consumer login/status/logout or CLI upgrade. This PR
  changes neither package versions nor release tags.
