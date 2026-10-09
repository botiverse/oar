# Runtime installers

Run on 2026-10-09 (Linux arm64, Debian 13, Node 24.18.1) through
[`experiments/runtime-install.ts`](../../experiments/runtime-install.ts) in a
bubblewrap sandbox: an empty writable `HOME`, the rest of the system read
only, PATH `/usr/bin:/bin` (no runtime on it, and not the folders the
installers use), `TMPDIR=/tmp`, no terminal and stdin closed, each runtime
(and each opencode line) in its own fresh `HOME`. Each run is the public
`installPlan()`, `install()`, `installation()`, `install()` again (for
opencode, asking for the other line) and `checkUpdate()`, then the runtime's
own updater asked how it sees the copy. Versions installed: claude 2.1.295,
codex 0.162.0, grok 1.0.50, kimi 2.1.1, opencode 1.18.35 (`v1`) and 2.0.26
(`v2`). The contract built on these facts is
[runtime install](../spec/install.md).

**Not run:** macOS and Linux x64 (the same scripts, with their own platform
branches), and Windows, where oar runs no installer (`platform`).

## Per runtime

| Runtime | Result | Probe found | The updater afterwards |
| --- | --- | --- | --- |
| claude | installed (31 to 44 s, three runs) | `~/.local/bin/claude`, `2.1.295 (Claude Code)`, off PATH | `checkUpdate` ok from `downloads.claude.ai/claude-code-releases/latest` (channel latest, current); `.claude.json` `installMethod: native` |
| codex | installed (20 to 28 s, three runs) | `~/.local/bin/codex`, `codex-cli 0.162.0`, off PATH | `checkUpdate` ok from `codex doctor --json` (current); doctor's update action `standalone installer` |
| grok | installed (10 to 12 s, three runs) | `~/.grok/bin/grok`, `grok 1.0.50` | `checkUpdate` ok, channel stable (current); `grok update --check --json` installer `internal` |
| kimi | installed (32 to 46 s, four runs) | `~/.kimi-code/bin/kimi`, `2.1.1` | `checkUpdate` ok from `code.kimi.com/kimi-code/latest` (current); `kimi upgrade -y`: "Kimi Code is already up to date (v2.1.1)." |
| opencode `v1` | installed, `line: "v1"` (10 to 13 s, four runs) | `~/.opencode/bin/opencode`, `1.18.35` | no `checkUpdate` in oar; `opencode upgrade`: "Using method: curl", "skipped: 1.18.35 is already installed" |
| opencode `v2` | installed, `line: "v2"` (15 s; the script also twice by hand) | `~/.opencode/bin/opencode`, `opencode v2.0.26` | `opencode upgrade`: "Using method: curl", "OpenCode upgrade skipped: 2.0.26 is already installed" |
| opencode, no line | `line_required` ("choose a release line: v1, v2"), plan the same, nothing ran | not_found | |
| antigravity | unsupported `requires_gui`, plan the same, nothing ran | not_found | |

In every installed run the second `install()` was `already_installed` and
ran nothing. For opencode it asked for the other line: after `v2`,
`install({ line: "v1" })` was `already_installed` with `line: "v2"` and the
binary still `opencode v2.0.26` (the 1 script would have replaced it,
[anomalyco/opencode#54084](https://github.com/anomalyco/opencode/issues/54084));
after `v1`, `v2` likewise found `v1`. Each installer's own progress came
back verbatim as `output`.

## What each installer did besides the binary

- **claude** wrote `~/.local`, `~/.claude`, `~/.claude.json` and
  `~/.cache/claude`, and no shell profile: for the missing PATH entry it
  printed `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc` instead
  of running it.
- **codex** (with `CODEX_NON_INTERACTIVE=1`) added its PATH block to
  `~/.bashrc` and asked nothing.
- **grok** added `~/.grok/bin` to PATH in `~/.bashrc`; with neither
  `~/.local/bin` nor `/usr/local/bin` on PATH, it linked nowhere else.
- **kimi** added `~/.kimi-code/bin` to PATH in `~/.bashrc` and wrote
  `~/.kimi-code/region` (`mainland-cn`).
- **opencode** (both lines) found no shell profile and created none: it
  printed the `export PATH` line. The `v2` script also writes an
  `opencode2` shim beside `opencode`.

## A failed install

With the network cut (`--unshare-net`), claude's `install()` was `failed`
with `exitCode: 0` and `output` `curl: (6) Could not resolve host:
claude.ai`: `curl | bash` exits with bash's status, and bash ran an empty
script. Only the probe afterwards (not_found) tells this apart from success.

The sandbox needs `TMPDIR` to exist: kimi's installer stops at
`mktemp: too few X's in template 'kimi-install'` when it does not.

## Answers without running anything

| Environment | Answer |
| --- | --- |
| `KIMI_INSTALL_DIR=/opt/kimi-code` (`/opt` root-owned) | kimi `unsupported` `requires_privileges`: "the installer writes /opt/kimi-code, and /opt is not writable by this user" (kimi's own docs pipe this case to `sudo`) |
| PATH holding only `sh` and `bash` | claude `unsupported` `missing_tool` `curl` |
