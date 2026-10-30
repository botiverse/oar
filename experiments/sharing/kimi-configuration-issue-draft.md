# Draft: ACP later sessions can retain pre-edit configuration

Status: review draft only, not submitted upstream.

This report and reproduction were prepared by an AI agent. If approved for
submission, it will also be submitted by the agent and retain this disclosure.

## Environment

- `@moonshot-ai/kimi-code` 2.4.1, Linux x64, Node 24.19.0.
- `kimi acp`, one initialized/authenticated native connection, disposable
  `KIMI_CODE_HOME` and working directories.
- Local OpenAI-compatible scripted provider with synthetic credentials;
  native session lifecycle, instructions, MCP and hooks. No real account.

## Reproduction

1. In the disposable user config, register a `PreToolUse` command hook for
   `mcp__scope__echo` that appends marker `A` and its input to a file. Write
   marker `OAR_DIRECTORY_RULE_A` in the project's `AGENTS.md`.
2. Start `kimi acp`, initialize/authenticate, create session A with that cwd
   and a stdio echo MCP server, then complete one tool turn. Observe hook A
   and instruction A in the captured provider request.
3. Replace the hook configuration with marker B and change `AGENTS.md` to
   `OAR_DIRECTORY_RULE_B`.
4. Create session B on the same connection and invoke echo. In the first
   control B uses the same directory while A is still live. Also repeat in
   fresh fixtures with B in a different directory, and with A closed before
   B opens in A's directory. Those two controls wait three seconds between
   editing the files and opening B.
5. Repeat each sequence with B on a newly started ACP process, keeping the
   same filesystem/configuration edits. This is the fresh-process control.

The [reproduction entry](same-directory.ts) and
[scope controls](kimi-configuration.ts) preserve native calls, provider
requests, hook events and timing. Run from this repository with the exact
native binary:

```sh
OAR_KIMI_BIN=/absolute/kimi pnpm tsx experiments/sharing/same-directory.ts kimi
```

## Actual observations

| B opening mode | B instruction marker on existing connection | B hook on existing connection | New-process B |
| --- | --- | --- | --- |
| Same directory, A live | A | A | B instructions and B hook |
| Different directory, after three-second wait | B | A | B instructions and B hook |
| A closed, same directory, after three-second wait | B | A | B instructions and B hook |

MCP server identity itself remained isolated. In all rows the separate-process
control read the new hook configuration. The shared hook discrepancy therefore
survives a directory change and closing the previous session. The finite
wait does not prove indefinite staleness or identify the cache implementation.

## Expected behavior or clarification

A newly created session should read the current configuration, or ACP should
provide a documented refresh operation/barrier that a host can await before
opening it. Otherwise reusing an ACP process changes the next session's
configuration compared with starting a process at that moment.

The documented ACP methods expose model/mode/thinking changes but no general
configuration reload. Source inspected at `a2afdbc7` contains internal
`ConfigService.reload()` and instruction-file watchers; its package version
is 2.4.1, but npm metadata does not identify that as the published build
commit. We are not claiming that no reload mechanism exists, that watchers
never run, or that the inspected implementation explains the observed build.
Is there a supported ACP refresh boundary, or should `session/new` re-read
these files before constructing its session?

[Full report, source links and evidence limits](same-directory-2026-10-30.md#kimi-scope-and-native-refresh-audit).
