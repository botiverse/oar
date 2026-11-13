# OpenCode 2.3.0 background child attribution

OpenCode 2.3.0 delivers background child output through
`opencode/session/child_update` when the client declares
`clientCapabilities._meta["opencode/child-session-updates"]: true`.
Its old standard-update projection drops child output after the originating
parent prompt ends. Waiting longer does not recover that output.

Two native Linux x64 controls ran on 2026-11-13 with Node 24.19.0 and OAR
`0503b815`, one per capability setting. Each used an isolated HOME and a
scripted local provider, then observed 60 seconds after the parent prompt
returned. No account or paid inference was used.

| Observation | Capability disabled | Capability enabled |
| --- | --- | --- |
| Parent prompt returned | 1893 ms | 1695 ms |
| Attributed standard child updates | 0 | 0 |
| Extension notifications | 0 | 4 |
| Child status | No notification | created 1658 ms; running 1660 ms; completed 1707 ms |
| Child text | No notification | `ANSWER_A_childreply` at 1706 ms |
| Parent model received native child completion report | Yes | Yes |

Timestamps are relative to the start of each probe, before initialization.
Both controls actually completed the child: the native parent model input
contains a `<subagent state="completed">` report with `ANSWER_A_childreply`.
The enabled control received child text and completion after the parent's
`end_turn`. The disabled control received neither, even after 60 seconds.
The [disabled](disabled.json) and [enabled](enabled.json) files retain all
captured ACP messages, the completion report and raw-source SHA-256 hashes.
Generated session/message IDs and the temporary HOME are replaced consistently.

## Identity and scope

The wire method has no leading underscore. Its envelope carries
`rootSessionId`, `childSessionId`, `parentSessionId`, `depth` and `title`.
`type: "update"` carries a SessionUpdate whose `_meta` retains
`opencode/child-session`. `type: "status"` carries the observed created,
running and completed states.

The extension does not contain a parent tool-call ID. In these controls,
the root tool `call-A_child` has `rawOutput.metadata.sessionID` matching the
child ID. That is separate evidence of the tool association; a parent session
ID must not be used as a tool-call ID.

This is a direct native ACP comparison, not validation of an updated OAR
adapter. It covers one text-only child. Nested grandchildren, child tools,
permissions, failure, interruption and resume were not exercised. The
existing OAR cleanup test remains pinned to 2.2.7. Its 2.3.0 diagnostic
stopped at the missing graph edge, before abort and disposal assertions;
[the daily report](../runtime-version-checks/2026-11-13.md#opencode-230)
retains the first failure and the unchanged 2.2.7 passing control.

## Source

The [2.3.0 release](https://github.com/anomalyco/opencode/releases/tag/v2.3.0)
introduces background subagents by default. At its pinned source commit
`a6b15d33daf6ab7d35569f6d711fdb630b9f04e7`, the ACP implementation is under
`packages/cli/src/acp`, rather than the older `acp/event.ts` location:

- [capabilities.ts](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/cli/src/acp/capabilities.ts#L9): reads the client capability.
- [child.ts](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/cli/src/acp/child.ts#L3): extension method, event shape and metadata projection.
- [translate.ts](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/cli/src/acp/translate.ts#L139): `projectChild` requires the originating prompt; `route` at line 432 selects standard or extension delivery.
- [turn.ts](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/cli/src/acp/turn.ts#L330): the background observer clears `ctx.start`, disabling the old projection.
- [subagent.ts](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/tool/plugin/subagent.ts#L194): starts background work and immediately returns session ID and running status.
- [background-turn.subprocess.test.ts](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/cli/test/acp/background-turn.subprocess.test.ts): upstream control for a parent response after `end_turn`.

## Reproduce

After `pnpm install --frozen-lockfile`, select an exact 2.3.0 installation:

```sh
OAR_OPENCODE_BIN=/absolute/path/to/opencode-2.3.0 pnpm tsx experiments/opencode-child-background/probe.ts /private/output/disabled disabled
OAR_OPENCODE_BIN=/absolute/path/to/opencode-2.3.0 pnpm tsx experiments/opencode-child-background/probe.ts /private/output/enabled enabled
```

Raw output includes local paths. Use the selected JSON beside this report
for sharing. The committed probe counts actual user-role completion reports,
excluding mentions in tool descriptions. The original run used the same
native requests and timing; the final probe also validates arguments and
attempts every cleanup if evidence writing fails.

The final probe ran once more in enabled mode after the report rebase onto
`4d5088fc`: four extension notifications and one native completion report;
parent prompt returned at 1995 ms and child completed at 2008 ms. This
validates the published script without replacing either original control.
