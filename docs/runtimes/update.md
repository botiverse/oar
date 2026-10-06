# Runtime updaters

Probed on 2026-10-01 (Linux x64, Node 24.19.0) in sandboxed homes, with no
terminal and stdin closed. Versions then: claude 2.1.286 (stable 2.1.285),
codex 0.159.3, grok 1.0.46, kimi 2.1.1, Antigravity ACP server 1.2.1 in
the registry. The contract built on these
facts is [runtime updates](../spec/update.md).

## What every updater shares

Each runtime that has an updater runs it without a prompt, except kimi
without `-y`. None of them can be judged by its exit code; each reported
success for a copy it did not change:

| Runtime | Exit 0, nothing upgraded |
| --- | --- |
| claude | `DISABLE_UPDATES` set; a Homebrew or mise copy (prints the `brew upgrade` instruction); an npm update that went to another npm prefix |
| codex | Standalone download failed (`curl \| sh` hides it, then "Update ran successfully!"); an npm update to another prefix |
| grok | A copied binary, a `GROK_BIN_DIR` install, or an npm prefix mismatch: the updater updates its own managed copy instead |
| kimi | No `-y` and no terminal; Homebrew; an npm layout it does not recognize (prints the manual command) |

So oar reads the executable's `--version` before and after.

## Per runtime

**claude.** Installs: native (`~/.local/bin/claude` links into
`~/.local/share/claude/versions/<v>`), npm, Homebrew, WinGet, apt/dnf/apk.
`claude update` updates the running copy with that copy's own method. Channels
`latest` and `stable` (settings `autoUpdatesChannel`); on `stable`,
`claude update` can move to an older version. No check only mode; the native
updater reads `downloads.claude.ai/claude-code-releases/{latest,stable}`, the
npm one the dist tags. Background auto update runs only in interactive
sessions; `DISABLE_AUTOUPDATER` stops it but not `claude update`.

**codex.** Installs: standalone (`$CODEX_HOME/packages/standalone/releases`,
`current` link), npm (a Node launcher), Homebrew on macOS. `codex update` never
checks; it reruns the installer or `npm install -g` every time. It refuses
(exit 1) for any binary outside the known layouts, including a standalone
binary run under another `HOME` or `CODEX_HOME`. `codex doctor --json` gives
the check: row `updates.status`, `latest version` and `latest version status`.
The CLI only shows an update banner; the app server daemon updates its own,
separate copy.

**grok.** Installs: official script (versioned files linked from
`~/.grok/bin`), npm (which creates a second copy), WinGet. `grok update` never
prompts; `--check --json` reports `currentVersion`, `latestVersion`,
`updateAvailable`, `installer` (`internal`, `npm`, `gh-release`), `channel`
and `error`, and always exits 0. `--alpha`/`--stable` persist the channel even
with `--check`. Any `npm_config_user_agent` (set by `npm run`, `pnpm run`)
makes it treat a script install as npm. It auto updates on launch from
`~/.grok/bin`, including `grok agent stdio`; see [grok](grok.md).

**kimi.** Installs: official script (`~/.kimi-code/bin/kimi`), npm, pnpm,
yarn, bun, Homebrew. `kimi upgrade -y` (from 0.43.0) upgrades without a
prompt; before 0.43.0 only a terminal prompt upgrades. A native upgrade stages
the binary and swaps it in at the next start of any command, `--version`
included. It reads `code.kimi.com/kimi-code/latest` (`code.kimi.ai` for the
`global` region) and ignores the staged rollout. Auto update runs only in the
interactive TUI.

**antigravity.** `agy_acp_server` has no updater and Google publishes no
latest pointer. The ACP registry lists a zip per platform and trails Google's
downloads (1.2.1 listed while 1.3.0 was downloadable). The `agy` CLI's own
`update` does not touch the ACP server.

**pi and cursor.** In process through their SDKs: the pi SDK is a
dependency of oar (`^1.0.2`), and `@cursor/sdk` an optional peer dependency
(`1.0.36`) that the host installs and hands to `createCursorRuntime` (the oar
CLI depends on it). Both installations are `via: "bundled"`; neither runtime
has `checkUpdate` or `upgrade`, so `oar upgrade` reports each as bundled with
oar and moving with the oar version.

## oar runs

`oar upgrade <runtime>` against older sandbox installs, 2026-10-01:

| Runtime and install | Result |
| --- | --- |
| claude native 2.1.280 | upgraded to 2.1.286 (4 s) |
| codex npm 0.155.0 | upgraded to 0.159.3 (7 s) |
| codex standalone (official script) 0.155.0 | upgraded to 0.159.3 (4 s) |
| grok script 1.0.44, under `npm_config_user_agent` | upgraded to 1.0.46, no npm copy created |
| kimi native 2.1.0 | upgraded to 2.1.1 (23 s, staged then swapped) |
| kimi npm 2.1.0 | unchanged: kimi did not recognize the npm layout and printed the manual command; `kimi upgrade -y` run directly in the same sandbox refused the same way |
| kimi native 0.38.0 | unsupported: requires_terminal |
| antigravity 1.3.0 | check: no update (registry lists 1.2.1); no updater |
