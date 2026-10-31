# Same-directory isolation and configuration freshness

Runtime version check: 2026-10-30.

The earlier sharing reports used different directories for A and B. They do
not establish same-directory MCP isolation or fresh configuration for later
sessions. The original Linux x64 follow-up found same-directory MCP crossover
in OpenCode 2.2.3 and Qoder 1.1.81, and stale configuration in Kimi 2.4.1.
The subsequent three-platform run below reproduced those results. New
configuration coverage is reported separately in the
[coverage follow-up](configuration-coverage-2026-10-30.md). No native adapter is enabled.

## Method and retained evidence

This method and the tables below describe the original probe change on
base `8858813` and its merged three-platform version `0a8c5e9`. The current
reproduction command runs the extended probe: six native hook sources,
Antigravity's `GEMINI.md` attempt, Grok's disposable folder-trust policy,
and Codex's per-session trust parameters and controls. See the
[coverage follow-up](configuration-coverage-2026-10-30.md) for those newer
observations and their limitations.

Run [same-directory.ts](same-directory.ts) with Node 24 and an exact native
binary. Each runtime gets two disposable cohorts: one shared native
connection, then separate processes with the same directory. Both sessions
register the MCP server name `scope`, running the same echo script with a
different argument, A or B. Actual MCP calls append their configured identity,
unique input and result to a journal before answering. The provider transcript
or Qoder native frame must also retain that invocation's exact result.

The sequence is A before B exists, B after joining, A after B joins, then
A/B concurrently. Every input is unique, so an old correct result in history
cannot mask a newer wrong call. Missing, duplicate or wrong-server calls
fail. The final complete journal rechecks all five inputs, including late
duplicates and misroutes. A recorded three-second settling period follows each initial open;
this is neither a retry nor proof of readiness. Each cohort stops before
the next starts. Installation, native deadlines, cleanup errors, original
synthetic protocol evidence and configuration observations are retained in
ignored `oar-trial-run/same-directory-<runtime>/evidence.json`, created with
mode 0600 where supported. Cleanup is registered as each resource is acquired
and always attempted, even if fixture setup or evidence collection throws.
No real credentials or paid model are used.

The original run also changed project `AGENTS.md` from marker A to marker B after
A's baseline and before opening B. Those markers are never prompted.
Kimi's disposable `KIMI_CODE_HOME/config.toml` and Qoder's project
`.qoder/settings.json` install a `PreToolUse` hook that journals revision,
event and actual cwd. They are also changed from A to B. Other runtimes'
hooks were **not exercised by that version**. Presence in provider history shows a file was
read, not which instruction wins; absent markers or hooks do not establish
unsupported configuration or freshness. Qoder uses native fake responses,
which do not expose the model's instruction input here.

[Selected Linux observations](selected-same-directory-2026-10-30.json)
retain marker identities, actual calls, close controls and configuration
observations without transcripts, paths, session IDs or account fields.
One revised run per runtime is selected, including the release controls and
Kimi timing controls. The source base was `8858813`; these are measurements
of this probe change on a local Linux x64 host, not results from a dispatched
workflow.

## Three-platform confirmation

[Run 41132390241](https://github.com/botiverse/oar/actions/runs/41132390241)
ran the merged probe at `0a8c5e982235ee59de0cd494b02b99ed415fe375` with
`same_directory_only=true`: six pinned runtimes on Linux x64, Windows x64
and macOS arm64. All 18 installations completed; all 18 same-directory
steps failed on the expected measured difference or missing configuration
coverage. Failure alone is not a regression verdict. The
[selected platform evidence](selected-directory-platforms-2026-10-30.json)
retains every artifact ID, actual five-turn invocation, final journal check,
release result and configuration comparison. Antigravity's Windows native
installation did not report a version string; 1.4.5 is its workflow package
pin, retained separately from the null reported version.

All three platforms match the original Linux tables below: Codex, Kimi,
Grok and Antigravity route all five inputs correctly in both cohorts;
OpenCode and Qoder cross-route A to B only in the shared cohort. Every
runtime's B survives A's release. Only OpenCode still invokes the old B
server after both sessions close and an empty-MCP session reopens on that
process. Qoder's close control does not retain it. Antigravity accepts
`session/close` without advertising it on all three platforms.

Kimi's immediate later B sees the old instruction and hook in shared mode;
a three-second wait before B makes the instruction current whether A is
live, closed or in another directory, but the old hook persists in all
three controls on all platforms. The other five runtimes' configuration
coverage gaps also match the original Linux run. The OpenCode/Qoder
process-lifetime directory restriction and Kimi isolation conclusion
therefore have three-platform evidence. These historical runs do not
inherit the subsequently added hooks or trust conditions.

## Linux MCP comparison

The five columns name the actual server that received the unique input.
Correct routing is A, B, A, A, B. The separate-process cohort has that result
for all six runtimes, including the same-directory shared-file controls.

| Runtime/version | A before B | B after join | A after B | A concurrent | B concurrent | Shared MCP result |
| --- | --- | --- | --- | --- | --- | --- |
| Codex 0.166.0 | A | B | A | A | B | established for this comparison |
| Kimi 2.4.1 | A | B | A | A | B | established for this comparison only |
| Grok 1.0.70 | A | B | A | A | B | established for this comparison |
| OpenCode 2.2.3 | A | B | B | B | B | crossover |
| Antigravity 1.4.5 | A | B | A | A | B | established for this comparison |
| Qoder 1.1.81 | A | B | B | B | B | crossover |

All six runtimes release A, invoke B again to check the survivor, then release
B and open the same directory with an empty client MCP configuration. The
provider requests the old echo tool. The shared cohort reuses the original
process; the separate cohort starts a fresh one. Codex uses
`thread/unsubscribe`; ACP uses `session/close` and disposes the
per-session OAR terminal owner; Qoder uses `daemon.close_session`.
An ACP method-not-found response would leave only the OAR terminal-owner
release and be recorded as **no native close**, never described as a native
session closing. All four tested ACP versions accepted the native close.
Antigravity 1.4.5 accepted it despite not advertising that capability; both
facts are retained. Whether a future Antigravity adapter may rely on that
unadvertised operation remains a separate admission decision. The current
isolated adapter's disposal behavior is unchanged.

| Runtime | Release operation | B after A release, both cohorts | Original process after both releases, empty MCP | Fresh process, empty MCP |
| --- | --- | --- | --- | --- |
| Codex 0.166.0 | `thread/unsubscribe` | B, correct result retained | no MCP call | no MCP call |
| Kimi 2.4.1 | `session/close` | B, correct result retained | no MCP call | no MCP call |
| Grok 1.0.70 | `session/close` plus OAR terminal disposal | B, correct result retained | no MCP call | no MCP call |
| OpenCode 2.2.3 | `session/close` | B, correct result retained | B receives call; result retained | no MCP call |
| Antigravity 1.4.5 | accepted `session/close`, not advertised | B, correct result retained | no MCP call | no MCP call |
| Qoder 1.1.81 | `daemon.close_session` | B, correct result retained | no MCP call | no MCP call |

For OpenCode, the [official ACP documentation](https://opencode.ai/v2/docs/cli/acp#MCP-servers)
explains directory-scoped client MCP registration, same-name replacement and
retention for the ACP process lifetime. The v2.2.3
[`ACPSessions.registerMcp` source](https://github.com/anomalyco/opencode/blob/v2.2.3/packages/cli/src/acp/sessions.ts)
passes the attached directory to native MCP registration. This is documented
design; no upstream defect is claimed. Qoder's exact cache scope/lifetime has
not been established from native documentation or source. Only the observed
crossover and non-retention close control are claimed.

Both future adapters require **one session per canonical directory for the
entire process lifetime**. Release does not make that directory reusable.
An automatic request for a used directory opens a fresh isolated process;
explicit `shared` refuses with `UnsupportedOptionError("placement")` before
opening on the old process. Identical or empty MCP lists do not bypass the
rule. For Qoder this is conservative: the one passing close control does not
prove every kind of directory state is safe to reuse. The corresponding
[design](../../docs/design/system.md#shared-runtime-processes),
[ACP spec](../../docs/spec/acp-shared-connection.md),
[OpenCode page](../../docs/runtimes/opencode.md#shared-process-admission-boundary)
and [Qoder page](../../docs/runtimes/qoder.md#shared-process-admission-boundary)
keep implementation separate from evidence.

## Project and user configuration comparison

A later session must read the configuration that an isolated process opened
at that moment would read. Otherwise automatic sharing changes behavior
silently. This is now an explicit admission requirement, not implied by MCP
routing. The following results are historical observations from the original
five-turn Linux cohorts on base `8858813`, repeated by `0a8c5e9` on three
platforms. They do not describe the current probe's expanded coverage.

| Runtime | Shared later B | Separate later B | Existing A after edit | Hook coverage |
| --- | --- | --- | --- | --- |
| Codex | AGENTS marker B | AGENTS marker B | marker A on both paths | not exercised |
| Kimi | AGENTS marker A; hook A | AGENTS marker B; hook B | marker/hook A on both paths | disposable user config, actual invocation |
| Grok | no AGENTS marker observed | no AGENTS marker observed | no marker observed | not exercised |
| OpenCode | AGENTS marker B | AGENTS marker B | history contains A and B on both paths | not exercised |
| Antigravity | no AGENTS marker observed | no AGENTS marker observed | no marker observed | not exercised |
| Qoder | model instructions not exposed | model instructions not exposed | hook switches to B on both paths | project config, actual invocation |

Codex/OpenCode agree with their fresh-process controls for the observed
instruction file; this does not establish all configuration or hook behavior.
Grok/Antigravity instruction freshness was **unverified in that probe**, not a pass.
The [coverage follow-up](configuration-coverage-2026-10-30.md) subsequently
observed Grok's markers with its explicit trust condition; Antigravity's
markers remain missing. Qoder
agrees with its control for the exercised project hook, but its instruction
freshness is unverified. Qoder's normal project-file refresh affects existing
sessions in both modes, so that refresh is not a sharing-only defect.

Source scope audit, separate from measured freshness:

- [OpenCode ACP configuration](https://opencode.ai/v2/docs/cli/acp) follows the
  session directory for models, agents, instructions, plugins and MCP. The
  probe measures only the stated subset.
- [Kimi hook documentation](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html)
  puts hooks in user configuration and runs them in the session cwd. Its
  [configuration documentation](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files)
  also describes workspace-local settings. The hook experiment does not
  pretend that the user config file is project-local.
- [Grok project rules](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/12-project-rules.md)
  and [settings](https://docs.x.ai/build/settings) describe project instructions
  and configuration. The lack of a marker in this ACP/provider observation
  does not establish that those native features are absent.
- [Antigravity rules](https://antigravity.google/docs/rules/) include directory
  instruction files; their freshness is not observed by this run.
- [Qoder hooks](https://docs.qoder.com/cli/hooks) describe project and user
  sources and configuration refresh. Only the project-hook path above ran.

### Kimi scope and native refresh audit

Additional controls in [kimi-configuration.ts](kimi-configuration.ts) first
run A, change files, wait three seconds **before** opening B, then observe B.
This bounded wait checks one asynchronous-refresh interval; it does not
prove a cache is permanent. A separate-process B repeats the same sequence.

| Scenario, all with a three-second wait before B | Shared B instructions | Shared B hook | Separate B instructions/hook |
| --- | --- | --- | --- |
| A live, B in the same directory after both edits | B | A | B / B |
| B in another directory after user hook edit | B | A | B / B |
| A closed, B in A's directory after both edits | B | A | B / B |

Each of these six cohorts verifies that B really invoked its MCP server,
retained its result and emitted a hook record for the matching input. Empty
hook journals cannot make the comparison pass. The immediate same-directory
opening in the main run saw instruction A; with the same three-second delay,
both live-A and closed-A cohorts saw B. Closing A is therefore not established
as the cause of instruction refresh. The hook discrepancy remains in all
three delayed controls, including another directory and `session/close`, so
a one-active-session-per-directory restriction does not solve that discrepancy. Kimi 2.4.1 is not admitted: `auto` remains isolated and
explicit `shared` refuses. Its adapter work is deferred.

The public [ACP method matrix](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp)
documents session lifecycle and model/mode/thinking changes, with no general
configuration refresh operation. Source inspected at
[`a2afdbc7`](https://github.com/MoonshotAI/kimi-code/tree/a2afdbc7d1fa0737d45d5780cc6c2bd38e477b55)
reports package version 2.4.1 but is not a verified npm build commit:

- [`ConfigService`](https://github.com/MoonshotAI/kimi-code/blob/a2afdbc7d1fa0737d45d5780cc6c2bd38e477b55/packages/agent-core-v2/src/app/config/configService.ts)
  has a file watcher and internal `reload()`.
- [`WorkspaceInstructionsService`](https://github.com/MoonshotAI/kimi-code/blob/a2afdbc7d1fa0737d45d5780cc6c2bd38e477b55/packages/agent-core-v2/src/workspace/workspaceInstructions/workspaceInstructionsService.ts)
  also watches and reloads instruction files.
- The [ACP server](https://github.com/MoonshotAI/kimi-code/blob/a2afdbc7d1fa0737d45d5780cc6c2bd38e477b55/packages/acp-server/src/server.ts)
  exposes only model/mode/thinking in `set_config_option`; no callable general
  reload was found in its registered methods or builtin slash commands.

Internal reload paths therefore exist, but a usable ACP freshness boundary
is not verified. The observations do not prove that watchers never fire or
identify why the tested build retained hooks. The
[upstream issue draft](kimi-configuration-issue-draft.md) is for review only;
it has not been submitted.

## Reproduction and remaining work

```sh
OAR_CODEX_BIN=/absolute/codex pnpm tsx experiments/sharing/same-directory.ts codex
OAR_KIMI_BIN=/absolute/kimi pnpm tsx experiments/sharing/same-directory.ts kimi
OAR_GROK_BIN=/absolute/grok pnpm tsx experiments/sharing/same-directory.ts grok
OAR_OPENCODE_BIN=/absolute/opencode pnpm tsx experiments/sharing/same-directory.ts opencode
OAR_ANTIGRAVITY_BIN=/absolute/agy_acp_server.par pnpm tsx experiments/sharing/same-directory.ts antigravity
OAR_QODER_BIN=/absolute/qodercli pnpm tsx experiments/sharing/same-directory.ts qoder
```

The report compares only observed instruction markers and exercised hook
revisions for B; an unobserved field is null, not a freshness pass. MCP
crossover, an observed configuration difference, or **missing instruction or
hook evidence** exits nonzero after saving evidence. Missing observations
explicitly report "missing evidence". Thus all six original Linux runs and the 18 platform runs fail
the complete revised gate: measured defects and missing coverage both remain
visible in the manual workflow. No runtime version on any platform currently
meets that complete gate. The
ordinary PR gate does not run this native evidence experiment.

The original three-platform same-directory run above is complete. After
the coverage follow-up merges, rerun the revised six-runtime probe on all
three platforms; use both scope flags false when also collecting resources. It retains old different-directory observations,
new same-directory/configuration observations, and resource groups even if
the new comparison fails. No automatic retries. Missing instruction/hook
coverage, exact platform results and any required admission restrictions
must be reviewed before adapter enablement. The finite configurations here
do not exhaust every project setting or plugin.
