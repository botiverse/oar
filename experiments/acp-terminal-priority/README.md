# ACP terminal process priority

Task #187, Linux, 2026-11-06. A real Grok process launched through a wrapper
had `oom_score_adj = 500`; the OAR host had `-1000`. Before this fix, its
`run_terminal_command` still ran at `-1000`. Four native reverse requests
(`terminal/create`, `terminal/wait_for_exit`, `terminal/output`,
`terminal/release`) identified the host-launched path. Grok 1.0.70 and 1.0.77
both reproduced the score mismatch. No account or real model was used.

The fix reads the current agent and host scores for each Linux terminal launch.
Equal scores or an unreadable score keep the original launch path, including
the original command name. Only differing scores use a small `/bin/sh` wrapper
to set the agent's value before `exec`. Score, command and arguments
are separate argv entries; shell-looking arguments are not evaluated. Native
full-shell compatibility still belongs to the runtime profile. The command
keeps the existing cwd, environment and owned process group. Missing commands
still take the existing spawn error path. If either score cannot be read,
launch proceeds unchanged; if setting it is refused, the command keeps its
inherited score. There is no public option or non-Linux behavior change.

## Native inventory

| Runtime | Version | Reverse terminal requests in this probe | Command score after fix |
| --- | --- | --- | --- |
| Grok | 1.0.70 | All four | 500 |
| Kimi | 2.4.1 | All four | 500 |
| CodeBuddy | 2.179.3 | All four | 500 |
| OpenCode | 1.19.5 | None; native command process | 500 |
| Antigravity CLI | 1.5.0 | None; native command process | 500 |

The host remained `-1000` in every case. The last two already inherited the
agent score; this does not claim that every tool in those runtimes avoids
reverse terminals. Results are in [selected.json](selected.json).

The inventory deliberately executes a single executable path. A separate
CodeBuddy 2.179.3 control sent a full command line without `args`; that existing
profile does not enable Grok's shell-line compatibility, so it was refused
with `ENOENT`. This task does not change that command-parsing behavior.

## Reproduce

Point `OAR_GROK_BIN`, `OAR_KIMI_BIN`, `OAR_CODEBUDDY_BIN`, `OAR_OPENCODE_BIN`
and `OAR_ANTIGRAVITY_BIN` at the intended native binaries, then run, for example:

```sh
pnpm tsx experiments/acp-terminal-priority.ts grok /tmp/grok-priority.json
CI=1 OAR_TEST=grok-aimock pnpm vitest run sea-trial/vendor/acp-terminal-priority.vendor.test.ts
```

Repeat the first command with `kimi`, `codebuddy`, `opencode` and `antigravity`.
The script uses isolated native configuration and a local scripted provider.
It raises only the agent wrapper's score, runs the native command tool, checks
that the host did not change, and disposes the session before deleting its
probe files. It requires Linux and a host score below 1000.

Linux vendor regressions cover Grok, Kimi and CodeBuddy. Unit regressions cover
pre-exec readback and child inheritance, literal argv/cwd/env, shell execution,
changing agent scores, equal-score command identity, unreadable processes,
relative PATH lookup, missing commands and descendant cleanup. Other platforms
run the existing terminal suite with their unchanged launch path.
