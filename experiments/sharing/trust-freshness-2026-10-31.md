# Native trust refresh and cross-directory configuration

Runtime version check: 2026-10-31.

No runtime is admitted to sharing by this change. Grok 1.0.70 now has complete
same-directory observations on all three platforms under the earlier
**trust-disabled** condition. New Linux controls also observe external native
trust grants and cross-directory freshness. The new Windows/macOS controls
remain pending. OpenCode still requires a new canonical directory for each
session in a process lifetime. Its new cross-directory project discovery and
user-configuration refresh controls pass on Linux.

## Reviewed three-platform run

[Run 41149607090](https://github.com/botiverse/oar/actions/runs/41149607090)
used main `41cb8254441bd0ef666d3e753fbba4b9683bb07c`, with six runtimes on
Linux x64, macOS arm64 and Windows x64. All 18 observations are retained in
[selected platform evidence](selected-directory-platforms-2026-10-31.json).
The [manifest](directory-platforms-2026-10-31.manifest.json) identifies every
artifact and exact version. These are account-free native programs with
local scripted providers, not synthetic protocol implementations.

| Runtime | Linux | macOS | Windows | Remaining qualification |
| --- | --- | --- | --- | --- |
| Grok 1.0.70 | same-directory checks pass | pass | pass | `folder_trust.enabled=false`; external trust changes and cross-directory freshness need the new controls |
| Codex 0.166.0 | pass, including four trust controls | pass, including four trust controls | hook evidence incomplete; native hook commands failed | persisted hook-trust changes remain untested on every platform |
| OpenCode 2.2.3 | shared MCP crossover and post-close retention | same | same | instruction markers and hooks agree, but same-directory configuration cannot justify different-directory freshness |
| Qoder 1.1.81 | shared MCP crossover; instruction markers missing | same | same | hooks agree; fake-response input does not expose instructions |
| Kimi 2.4.1 | later shared hook remains A; immediate instruction markers differ | same | later shared hook remains A; immediate instruction markers agree | stale hook is present on all three platforms |
| Antigravity 1.4.5 | instruction markers missing | same | same | MCP/release and hook observations agree |

The Codex Windows cell is incomplete admission evidence, not proof that
Windows lacks native hooks. The original selected observations keep that
boundary. Additional native failure facts are preserved beside them below.

## New controls and Linux results

`configuration-freshness.ts grok` runs three scenarios, each with a shared
cohort and a separate-process control in fresh disposable homes. A stays
alive throughout each scenario. Both cohorts use the same order and recorded
three-second settling periods; no difference is attributed to closing A.

1. **External trust grant.** Folder trust remains at its enabled default.
   Project `AGENTS.md` and `.grok/hooks/directory.json` initially contain A.
   A invokes its supplied MCP tool but sees neither project marker nor
   project-hook invocation. The probe writes revision B, then starts a
   **separate native `grok --trust agent --always-approve --no-leader stdio` process** in the
   project directory. That process initializes and writes
   `GROK_HOME/trusted_folders.toml`; the probe records the before/after store
   and its shutdown. The original process must remain alive before and after
   the grant. B opens only after the grant, on that original connection or a
   newly started connection for the control. No session parameter grants
   trust and the probe never writes the trust store itself. The ACP fixture's
   existing `--always-approve` tool permission option is symmetric; the
   untrusted A control verifies that it does not bypass the project-file gate.
2. **Different directories, user hooks.** A opens in one canonically distinct
   project, B in another. Each project is granted trust by an independent
   native process; B's grant occurs while A's process lives. B's project
   instructions and the disposable user hook change to B before B opens.
   This exercises the user hook configuration that a process could cache
   across directories.
3. **Different directories, project hooks.** The same order uses each
   project's own `.grok/hooks/directory.json`. This separately observes
   project-hook discovery under default trust.

`configuration-freshness.ts opencode` runs two scenarios, each with shared
and separate-process cohorts:

1. **Project configuration discovery.** Each project has its own `AGENTS.md`
   and local V2 `execute.before` plugin. B's files are created in a directory
   the process has not opened before. This establishes discovery, not refresh
   of previously loaded user configuration.
2. **User configuration refresh across directories.** Both instruction and
   plugin files live in the same disposable `XDG_CONFIG_HOME/opencode`:
   `AGENTS.md` and `plugins/directory-observer/index.ts`. They contain A when
   the native process starts and A runs its first turn. The probe rewrites
   those same files to B while A remains open, then opens B in a distinct
   project directory. Neither project contains the observation files in this
   scenario. A new native process starts after the same file changes and
   settling delay for the control. This exercises user configuration already
   loaded by the shared process. The file locations follow OpenCode's
   [global rules](https://opencode.ai/docs/rules/#global) and
   [local plugin locations](https://opencode.ai/docs/plugins/#from-local-files);
   positive native observations establish their use in 2.2.3.

Each process sees a project directory at most once. Neither scenario reuses
a released directory or claims to fix the known same-directory MCP behavior.

Every cohort invokes A before B opens, invokes B, then invokes A again.
The final MCP journal must contain exactly one correctly scoped call for
each input, and the provider request must retain its actual result. This
catches late duplicates as well as immediate crossover. B must expose only
marker B and execute only hook B; a stale fresh-process control cannot make
an equally stale shared result pass. Absence in the untrusted baseline
counts only with the actual MCP call and a positive post-grant B hook.
Evidence readers and teardown run even when observation fails.

| New Linux scenario | Shared | Fresh-process control | Later B configuration |
| --- | --- | --- | --- |
| Grok external native trust grant | pass | pass | marker B, project hook B |
| Grok different directories, user hook | pass | pass | marker B, user hook B |
| Grok different directories, project hook | pass | pass | marker B, project hook B |
| OpenCode different directories, project discovery | pass | pass | project marker B, both outer/inner hook entries B |
| OpenCode different directories, user refresh | pass | pass | user marker B, both outer/inner hook entries B |

[Selected local observations](selected-configuration-freshness-2026-10-31.json)
retain the positive and negative checks, native grant results, final MCP
checks, and comparison failures. The raw trust-store paths are omitted from
selection. All six Grok cohorts and all four OpenCode cohorts pass. The Codex
Linux comparison and its four trust controls also pass after the diagnostic
changes. These measurements cover the exercised files and hooks, not every
possible configuration field, nor updates to an already-open session's
configuration. In the Grok user-hook scenario, A's later turn still executes
hook A after the user hook file changes to B, on both paths. This observed
retention by an already-open session matches the separate-process control;
the freshness requirement here concerns the newly opened B.

The native Grok executable reports 1.0.70 (`f50904eaee6c`). Its hidden
[`--trust` CLI entry](https://github.com/xai-org/grok-build/blob/77cd7eb675ba911c225c3aaeeece3a20cbccc426/crates/codegen/xai-grok-pager/src/app/cli.rs#L465)
and [agent startup grant](https://github.com/xai-org/grok-build/blob/77cd7eb675ba911c225c3aaeeece3a20cbccc426/crates/codegen/xai-grok-pager-bin/src/main.rs#L1132)
guided the probe. That public source revision differs from the distributed
binary's revision; the measured native trust-file write and post-grant
observations establish the result for 1.0.70.

## Codex Windows hook failure investigation

The original Windows artifact contains **18** `hook/completed` events across
the two main cohorts and four trust cohorts. All have status `failed` and an
error entry `hook exited with code 1`. Native environment context reports
`powershell`. The hook journal remains empty. The selected evidence retains
completion status, duration, message, and exit code, with
`exitCodeSource: "native completion message"`; it does not manufacture a
structured native exit-code field or equate a missing code with zero.

Codex 0.166.0's
[session configuration](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core/src/session/mod.rs#L5713)
passes the session shell to its hook engine. Its
[PowerShell invocation](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core/src/shell.rs#L34)
uses `-Command`. The old probe produced a quoted executable followed by
quoted arguments without a call operator. In PowerShell, a quoted path is
an expression; invoking it requires the
[`&` operator](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_operators?view=powershell-7.5#call-operator-).
This is a concrete probe-command defect consistent with the native exit 1.

The revised Codex Windows command uses `&` and independently quoted
arguments. A regression executes a real Node hook with JSON stdin and paths
containing spaces/apostrophes; on Windows it also checks that the previous
expression exits 1. The existing Linux command and other runtimes are
unchanged. Actual Codex Windows hook completion after this correction still
requires the new native run; no Windows pass is inferred from source or from
a shell regression. Persisted Codex hook-trust changes remain a separate gap.

Future reports list `hook command execution failed (exit 1)` separately
from missing marker/journal evidence. Native failed status without a code is
also preserved. A command that writes a journal but later fails cannot make
a Codex trust control pass.

## Reproduction and next admission decision

From the repository root, with the pinned binaries installed:

```sh
OAR_GROK_BIN=/absolute/grok pnpm tsx experiments/sharing/configuration-freshness.ts grok
OAR_OPENCODE_BIN=/absolute/opencode pnpm tsx experiments/sharing/configuration-freshness.ts opencode
OAR_CODEX_BIN=/absolute/codex pnpm tsx experiments/sharing/same-directory.ts codex
```

The manual evidence workflow runs these new Grok/OpenCode controls as a
separate step, even if an earlier same-directory observation fails. It uses
no automatic retries. Each observation step retains its 12-minute limit;
the job limit is 65 minutes for installation plus up to four observation
steps. `same_directory_only=true` now includes these trust and different-
directory controls, while `resources_only=true` still excludes them.

Rebuild the 18 selected platform observations without editing the manifest:

```sh
gh run download 41149607090 --repo botiverse/oar --dir /tmp/oar-directory-platforms
python3 experiments/sharing/select-directory-evidence.py \
  experiments/sharing/directory-platforms-2026-10-31.manifest.json \
  /tmp/selected-platforms.json --input-root /tmp/oar-directory-platforms
```

Local selection uses `configuration-freshness-2026-10-31.manifest.json` and
`--input-root oar-trial-run`. Its source metadata names the base and the
measured raw-input SHA256; rerunning creates new timestamps and raw hashes,
so update that source metadata for a new measurement rather than relabeling
it as this run. The earlier selected October 30 observations stay unchanged.

Cindy will dispatch the new controls on all three platforms after this
probe change merges. Grok 1.0.70 is the next candidate only if those checks
complete on all three platforms; its existing resource/observation evidence
then joins the new trust and freshness evidence for review. OpenCode needs
its different-directory project-discovery and user-refresh results on all
three platforms before its constrained adapter can proceed.
Codex remains in the later batch, with Windows command execution and
persisted trust freshness still requiring native evidence.
