# Runtime updates

`runtime.checkUpdate(installation, options?)` reports the version the
runtime's own updater would install. `runtime.upgrade(installation, options?)`
runs that updater. Both are independent of sessions, like
[account usage](account-usage.md), and both are optional members; the
[table below](#per-runtime) says which runtime has which. The
[TypeScript contract](../../packages/oar/src/contracts/update.ts) defines the
results. The [runtime evidence](../runtimes/update.md) records how each
updater behaved when probed.

Both operations accept `AvailableInstallation | VersionUnsupportedInstallation`.
An old CLI remains refused for sessions and readers, but its located `command`
and `installedVersion` let a host offer the action that repairs it. Other
unsupported results and `not_found` are not update inputs. After upgrading,
probe again: a changed version does not by itself prove the adapter's floor
is satisfied. [Installation discovery](install.md) defines this distinction.

## Principles

- **Only the runtime's own updater installs.** Each updater knows how its copy
  was installed (official script, npm, Homebrew) and updates that copy.
  `upgrade` never runs an install script, because a second copy installed
  another way would compete on PATH; the vendor's installer runs only through
  [`install`](install.md), and only when the probe finds no copy.
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

When the check is unavailable because of a transient lookup error or disabled
checks, the updater may still run and its outcome is judged the same way.
Package-manager-owned or unrecognized Claude installations return
`unsupported_installation` without invoking `claude update`.

## Per runtime

| Runtime | checkUpdate reads | upgrade runs |
| --- | --- | --- |
| claude | `downloads.claude.ai/claude-code-releases/<channel>` (native) or the npm dist tag (npm copy, by layout or claude's recorded `installMethod`); channel from settings `autoUpdatesChannel`, held by `minimumVersion` | `claude update` |
| codex | `codex doctor --json`, row `updates.status` (the JSON decides; doctor exits 1 when any row fails) | `codex update` |
| devin | the release manifest named by the standalone installer's `distribution` marker beside the binary; Homebrew, Desktop and portal builds have none (`unsupported_installation`) | none: `devin update` asks for confirmation and has no `--yes` |
| factory | `droid update --check` (exits 0 either way: "Update available: X" or "Already up to date!" decides) | `droid update` |
| grok | `grok update --check --json` (exit is always 0; `error` decides) | `grok update` |
| kimi | `code.kimi.com/kimi-code/latest`, or `code.kimi.ai` for the `global` region; only a newer release counts | `kimi upgrade -y` (from 0.43.0) |
| codebuddy, dsh, qwen, qoder | none: OAR exposes no `checkUpdate` for them | none |
| pi-durable | none: `@earendil-works/pi-durable` is the host's to install | none |
| antigravity | The native CLI platform manifest; only a newer version counts | `agy update` |
| opencode | none: the native updater has no check-only mode | v2: `opencode upgrade` selects the method and release. v1 returns `unsupported_installation`. |
| pi | bundled / in-process: none. Standalone `createPiRuntime({ execution: "subprocess", command: "pi" })`: `pi.dev/api/latest-version`, newer semver only | standalone `command: "pi"`: `pi update --self --no-approve`; bundled: none |
| cursor | none: `@cursor/sdk` is the host's to install and pin (OAR's optional peer dependency, 1.4.1) | none |

A kimi native install stages the new binary and swaps it in on its next
start; the version read back after the upgrade is that start.

## Suggested minimum versions

OAR keeps three distinct version layers apart:

- **`minVersion` (hard floor)**: enforced by `installation()` and adapters.
  Copies below it fail with `version_unsupported` and cannot open sessions.
- **`suggestedMinVersion` (recommended threshold)**: maintained per runtime in
  `packages/oar/assets/suggested-versions.json` (single source of truth;
  `packages/oar/src/suggested-versions.generated.ts` is derived from it during
  `pnpm --filter @botiverse/oar build` and exported as `suggestedVersions`
  alongside `SUGGESTED_VERSIONS_URL`, `parseSuggestedVersions`, and
  `checkSuggestedVersion` from `@botiverse/oar/suggested-versions`,
  `@botiverse/oar`, and `@botiverse/oar/browser`). It names a recommended CLI
  version threshold for the runtime's current flagship models (for example,
  upstream client-version gating or built-in model catalog recognition), while
  remaining silent once met so minor patch releases do not nag users.
- **`checkUpdate` (`latest`)**: queries the runtime's live release channel.

Runtimes with no verified model gate or catalog threshold are omitted from
`packages/oar/assets/suggested-versions.json`, and `listModels()` remains
strictly a local live query (already surfacing native disabled model notices
such as Claude Code's `ModelEntry.disabled.reason`). Being below
`suggestedMinVersion` does not prove a model cannot run (for example, measured
Claude Code `2.1.319` already listed and ran `claude-fable-5-2` with an
unrecognized-model warning before built-in catalog recognition landed), and
meeting `suggestedMinVersion` does not guarantee account access. Hosts may fetch
`SUGGESTED_VERSIONS_URL` directly (with ETag caching) to surface recommendations
without waiting for a package release, falling back silently to the bundled
`suggestedVersions` or no hint on fetch/parse failure.

## CLI

`oar upgrade` and `oar upgrade --check` run these from a terminal; their
flags, output and exit codes are in the
[CLI reference](../../packages/cli/README.md#commands).
