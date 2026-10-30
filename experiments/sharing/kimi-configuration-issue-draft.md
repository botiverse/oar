# Draft: ACP later sessions retain pre-edit user hook configuration

Status: review draft only, not submitted upstream.

This report and reproduction were prepared by an AI agent. If approved for
submission, it will also be submitted by the agent and retain this disclosure.

## Environment

- `@moonshot-ai/kimi-code` 2.4.1, Linux x64, Node 24.19.0.
- `kimi acp`, one initialized/authenticated native connection, disposable
  `KIMI_CODE_HOME` and working directories.
- Local OpenAI-compatible scripted provider with synthetic credentials;
  native session lifecycle, MCP and hooks. No real account.

## Reproduction

1. In the disposable user config, register a `PreToolUse` command hook for
   `mcp__scope__echo` that appends marker `A` and its input to a file.
2. Start `kimi acp`, initialize/authenticate, create session A with a stdio
   echo MCP server, then complete one tool turn. Observe hook A in the hook
   journal, matched to the actual MCP input.
3. Replace the hook configuration with marker B.
4. Create session B on the same connection and invoke echo. First use the
   same directory with A still live, opening B immediately after the edit.
   In fresh fixtures also test A still live in the same directory, B in a
   different directory, and A closed before B opens in A's directory. These
   three controls all wait three seconds between editing and opening B.
5. Repeat each sequence with B on a newly started ACP process, keeping the
   same hook edit. This is the fresh-process control.

The [reproduction entry](https://github.com/botiverse/oar/blob/bafb98227f98cae0fad5051bedbb024386febc7e/experiments/sharing/same-directory.ts) and
[scope controls](https://github.com/botiverse/oar/blob/bafb98227f98cae0fad5051bedbb024386febc7e/experiments/sharing/kimi-configuration.ts) preserve native calls, provider
requests, hook events and timing. Run from this repository with the exact
native binary:

```sh
OAR_KIMI_BIN=/absolute/kimi pnpm tsx experiments/sharing/same-directory.ts kimi
```

## Actual observations

| B opening mode | B hook on existing connection | New-process B hook |
| --- | --- | --- |
| Same directory, A live, immediate B open | A | B |
| Same directory, A live, after three-second wait | A | B |
| Different directory, after three-second wait | A | B |
| A closed, same directory, after three-second wait | A | B |

The main five-turn run verified MCP isolation before/after B opened and
during concurrent calls. The additional delayed controls each verify B's
MCP identity and matching hook, without repeating all five turns. Each
separate-process control read the new hook configuration. The shared hook
discrepancy survives a directory change and closing the previous session in
these observations. The finite wait does not prove indefinite staleness or
identify the cache implementation.

## Expected behavior or clarification

A newly created session should read the current hook configuration, or ACP
should provide a documented refresh operation/barrier that a host can await
before opening it. Otherwise reusing an ACP process changes the next session's
hooks compared with starting a process at that moment.

The documented ACP methods expose model/mode/thinking changes but no general
configuration reload. Source inspected at `a2afdbc7` contains internal
`ConfigService.reload()`; its package version is 2.4.1, but npm metadata does
not identify that as the published build commit. We are not claiming that no
reload mechanism exists or that the inspected implementation explains the
observed build. Is there a supported ACP hook-refresh boundary, or should
`session/new` re-read hook configuration before constructing its session?

[Full report, source links and evidence limits](https://github.com/botiverse/oar/blob/bafb98227f98cae0fad5051bedbb024386febc7e/experiments/sharing/same-directory-2026-10-30.md#kimi-scope-and-native-refresh-audit).
