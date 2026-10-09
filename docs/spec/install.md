# Runtime install

`runtime.installPlan(options?)` says what installing a runtime would run on
this machine, or why it would run nothing. `runtime.install(options?)` runs
the runtime's own installer when the runtime's installation probe finds no
copy. Both are independent of sessions, like [updates](update.md), and both
are optional members that come together; the [table below](#per-runtime)
says which runtime has them. The
[TypeScript contract](../../packages/oar/src/contracts/install.ts) defines the
results. The [runtime evidence](../runtimes/install.md) records how each
installer behaved when run.

## Principles

- **Only the vendor's documented installer runs.** For each runtime, the
  installer script its vendor documents, run as documented (with the
  installer's own switch for skipping prompts, if it has one). Each adapter
  and runtime page cites the page that documents it. No mirrors, no pinned
  versions, no third party packages.
- **The method is the one the runtime's updater expects.** Each method puts
  the copy where the runtime's own updater recognizes it, so `checkUpdate()`
  and `upgrade()` work on it afterwards: never a copy that `checkUpdate()`
  would answer `unmanaged_installation` or `package_manager`.
- **The probe decides, not the exit code.** `install` probes first and runs
  nothing when the probe finds an available installation. After the installer
  ran, it probes again, with the same discovery sessions use: the result is
  `installed` only when that finds an available installation, whatever the
  installer exited with. An installer that puts the binary where the probe
  does not look is a probe to fix, so the probes also look where the
  installers put them (claude's `~/.local/bin`, codex's `~/.local/bin`, grok's
  `~/.grok/bin`, kimi's `~/.kimi-code/bin`, opencode's `~/.opencode/bin`),
  which a GUI or service process's PATH can miss.
- **`installPlan` is read only.** It looks up the installer's tools on PATH
  and checks that the directories it writes are writable, and never runs,
  downloads or writes anything. It gives the same `unsupported` that `install`
  would.
- **Never over another copy.** A runtime whose vendor ships parallel
  release lines of one command (opencode 1 and 2) declares them in
  `installLines`; the host passes one as `line`, since oar never chooses a
  line for the person, and a found copy of either line is
  `already_installed`, never replaced by the other.
- **`install` changes the machine.** oar never calls it on its own; the host
  calls it on a person's request. It runs like an [upgrade](update.md): with
  no stdin and no terminal (its own session and process group on POSIX),
  under a timeout (10 minutes by default) that stops the installer with
  everything it started, in the host environment minus package script
  markers. It never uses sudo and involves no credentials.

## Lines

`runtime.installLines` lists `{ line, description }` for a runtime with
parallel release lines (opencode: `v1`, `v2`) and is absent otherwise, so a
host offers the choice before it plans. `installPlan({ line })` and
`install({ line })` take one; without it they answer `line_required`, and
a line the runtime does not list (any line, for a runtime without lines) is
`unknown_line`. `installed` and `already_installed` carry the `line` of the
installation found, when its version tells (`already_installed` with
`line: "v2"` after asking for `v1`: nothing ran).

## Plan

`plan` carries the `steps` (`command`: the program and arguments `install`
spawns; `display`: the step as the vendor documents it), the `source` page,
and two constants: `network: true` (every installer downloads) and
`privileges: false` (an installer that needs more rights than the user has
is `unsupported` instead).

## Install results

| Kind | Meaning |
| --- | --- |
| installed | The probe after the installer finds an available installation (`installation`), whatever the installer exited with; `output` is the installer's stdout and stderr verbatim. |
| already_installed | The probe found an available installation first; nothing ran. |
| failed | The probe after the installer still finds nothing. `exitCode` is the installer's, 0 included (`curl \| bash` exits 0 when the download failed), or null when the timeout stopped it. |
| unsupported | Nothing ran; `reason` below, `detail` in plain words. |

| Reason | Meaning |
| --- | --- |
| platform | The installer does not run here. oar runs the macOS and Linux scripts (x64, arm64); on Windows the detail names the vendor's own Windows command, which oar does not run. |
| requires_privileges | A directory the installer writes is not writable by this user (an install location variable naming `/usr/local`, say). oar never uses sudo. |
| requires_gui | The vendor installs the runtime only from inside an app (antigravity). |
| missing_tool | A program the documented command runs (`curl`, `bash`, `sh`) is not on PATH; `detail` names it. |
| bundled | Nothing to install: the runtime comes with the package that carries it. No built-in runtime returns it, since bundled ones have no `install` at all. |
| line_required | The runtime has `installLines` and no `line` was given; `detail` lists them. |
| unknown_line | `line` is not one of the runtime's `installLines`. |

## Per runtime

Each method is the one the runtime's updater recognizes afterwards: claude's
native install is what `claude update` updates (`installMethod: native`),
codex's standalone install is what `codex update` reruns (doctor's update
action `standalone installer`), grok's script install is its `internal`
installer, kimi's native copy is what `kimi upgrade` stages updates for, and
each opencode line's `opencode upgrade` takes its script install as the `curl`
method and stays on the line.

| Runtime | install runs | Documented at | Puts it at |
| --- | --- | --- | --- |
| claude | `curl -fsSL https://claude.ai/install.sh \| bash` | [code.claude.com/docs/en/setup](https://code.claude.com/docs/en/setup) | `~/.local/bin/claude` → `~/.local/share/claude/versions/<v>` (native) |
| codex | `curl -fsSL https://chatgpt.com/codex/install.sh \| CODEX_NON_INTERACTIVE=1 sh` | [github.com/openai/codex](https://github.com/openai/codex#installing-and-running-codex-cli) | `$CODEX_INSTALL_DIR/codex` (default `~/.local/bin/codex`) → `$CODEX_HOME/packages/standalone/current` |
| grok | `curl -fsSL https://x.ai/cli/install.sh \| bash` | [docs.x.ai/build/overview](https://docs.x.ai/build/overview) | `$GROK_BIN_DIR/grok` (default `~/.grok/bin/grok`) → `~/.grok/downloads/grok-<v>-<platform>` |
| kimi | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash` | [github.com/MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code#install) | `$KIMI_INSTALL_DIR/bin/kimi` (default `~/.kimi-code/bin/kimi`) |
| opencode `v1` | `curl -fsSL https://opencode.ai/install \| bash` | [opencode.ai/docs](https://opencode.ai/docs/#install) | `~/.opencode/bin/opencode` (1.x) |
| opencode `v2` | `curl -fsSL https://opencode.ai/v2/install \| bash` | [opencode.ai/v2/docs](https://opencode.ai/v2/docs/) | `~/.opencode/bin/opencode` (2.x) |
| antigravity | nothing: `requires_gui` (installed from an editor's agent registry) | [antigravity.google/docs/ide/extensions/zed](https://antigravity.google/docs/ide/extensions/zed) | |
| pi | no `install`: bundled with oar | | |
| pi-durable | no `install`: `@earendil-works/pi-durable` is the host's to install | | |
| cursor | no `install`: `@cursor/sdk` is the host's to install | | |

Codex, grok and kimi also add their folder to PATH in the shell profile,
opencode only in a profile that exists, and claude prints the line instead.
Grok links itself into `~/.local/bin` or `/usr/local/bin` when one is on
PATH and writable; kimi renames an older Python `kimi-cli` it finds first on
PATH to `kimi-legacy`.

With an `OAR_<RUNTIME>_BIN` variable set, the probe looks only there, so an
install elsewhere ends `failed`.
