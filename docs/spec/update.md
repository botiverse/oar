# Runtime updates

`runtime.checkUpdate(installation, options?)` reports the version the
runtime's own updater would install. `runtime.upgrade(installation, options?)`
runs that updater. Both are independent of sessions, like
[account usage](account-usage.md), and both are optional members; the
[table below](#per-runtime) says which runtime has which. The
[TypeScript contract](../../packages/oar/src/contracts/update.ts) defines the
results. The [runtime evidence](../runtimes/update.md) records how each
updater behaved when probed.

## Principles

- **Only the runtime's own updater installs.** Each updater knows how its copy
  was installed (official script, npm, Homebrew) and updates that copy. oar
  never runs an install script itself, because a second copy installed
  another way would compete on PATH.
- **The version decides, not the exit code.** Updaters exit 0 without
  upgrading: codex when its download failed, claude when Homebrew owns the
  copy, grok when it updated a different copy, kimi when it needs a
  confirmation. `upgrade` reads `--version` from the same executable before
  and after, and reports what that executable says. The updater's stdout and
  stderr come back verbatim as `output`.
- **Checks are read only.** A check never installs and never changes update
  settings (grok's `--alpha`/`--stable` would persist a channel switch, so the
  check never passes them).
- **`upgrade` changes the machine.** oar never calls it on its own; the host
  calls it on a user's request. It runs with no stdin and no terminal (its
  own session and process group on POSIX), under a timeout (10 minutes by
  default) that stops the updater with everything it started (npm,
  `curl | sh`), in the host environment minus package script markers
  (`npm_config_user_agent`, `npm_lifecycle_*`), so a run under `pnpm run`
  does not turn grok into an npm install.
- **No guessing.** When the latest version cannot be read, the check is
  `unavailable` with a reason, never "current".

## Check results

`ok` carries `installed`, `latest`, `updateAvailable`, the `channel` when the
runtime has channels, and the `source` the answer came from (the command that
answered, or the release URL its updater reads). `latest` is that source's
version for the installation's channel, so it can be older than `installed`:
claude's stable channel trails a newer manual install, and `claude update`
then moves to the stable version. `updateAvailable` is the runtime's own
verdict where it gives one; otherwise `latest !== installed`.

| Reason | Meaning |
| --- | --- |
| unsupported_installation | Not a machine installed executable: a `bundled` installation moves with the package that carries it. |
| package_manager | A package manager (Homebrew, WinGet, mise) owns the copy and its updates. |
| unmanaged_installation | The runtime's updater does not recognize the copy (codex reports `manual or unknown` for a copied binary). |
| updates_disabled | The runtime's configuration turns updates off (claude `DISABLE_UPDATES`). |
| lookup_failed | The release source could not be read; `detail` carries the runtime's or the network's words. |
| version_unreadable | The installed or released version could not be read. |

## Upgrade results

| Kind | Meaning |
| --- | --- |
| upgraded | The executable reports a different version afterwards (`from`, `to`). |
| current | The check found nothing newer; no updater ran. |
| unchanged | The updater ran and exited 0, yet the executable reports the same version. `output` says why in the runtime's words; the installation's `shadowed` lists the other copies on PATH; a copy the updater installed off PATH is not among them. |
| failed | The updater exited non-zero or timed out, and the version did not move. |
| unsupported | This installation cannot be upgraded without a person: `requires_terminal` (kimi before 0.43.0) or `unsupported_installation`. |

When the check is unavailable, the updater still runs and its outcome is
judged the same way, so a Homebrew copy reports `unchanged` with the updater's
instruction to run `brew upgrade`.

## Per runtime

| Runtime | checkUpdate reads | upgrade runs |
| --- | --- | --- |
| claude | `downloads.claude.ai/claude-code-releases/<channel>` (native) or the npm dist tag (npm copy, by layout or claude's recorded `installMethod`); channel from settings `autoUpdatesChannel`, held by `minimumVersion` | `claude update` |
| codex | `codex doctor --json`, row `updates.status` (the JSON decides; doctor exits 1 when any row fails) | `codex update` |
| grok | `grok update --check --json` (exit is always 0; `error` decides) | `grok update` |
| kimi | `code.kimi.com/kimi-code/latest`, or `code.kimi.ai` for the `global` region; only a newer release counts | `kimi upgrade -y` (from 0.43.0) |
| antigravity | The ACP registry entry, which trails Google's downloads; only a newer registry version counts | none: no updater exists |
| opencode | none yet: `opencode upgrade` picks its source by install method (npm, Homebrew, Scoop, Chocolatey or the install script) and has no check-only mode | none yet |
| pi | none: bundled with oar | none |
| cursor | none: `@cursor/sdk` is the host's to install and pin (OAR's optional peer dependency, 1.0.37) | none |

A kimi native install stages the new binary and swaps it in on its next
start; the version read back after the upgrade is that start.

## CLI

`oar upgrade [runtime]` runs the updaters one runtime at a time and exits 1
when an upgrade is `failed` or `unchanged`, or a runtime could not be probed
(its report carries the error; the others are still reported). `--check`
only reports, `--json` prints the reports, `--timeout <ms>` bounds each
runtime's check and its updater run.
