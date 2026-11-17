# DSH launcher and output-schema boundaries

Measured on Linux x64 on 2026-11-16 with DSH 0.2.1-rc.5 and 0.2.2-rc.1,
separate temporary homes and a local scripted provider. No account login or
paid request was used. These are two independent SessionOptions probes;
other refused options are covered by [the remaining-option report](remaining.md).

## Result and adapter decision

Both `launchArgs` and `outputSchema` remain refused. The launcher refusal now
explains the measured reason: a later native overlay can disable OAR's bridge,
and arbitrary overlays have no verified effective-composition guard.

The native launcher accepts a second `--patch`: a harmless composition changed
the first prompt, a replacement applied on resume, and omission restored the
native prompt. But another overlay disabled the bridge, and another re-enabled
the ACP transport. A second profile is a native error, config dumps exit, and
the ACP profile accepts no application options. Passing only those remaining
arguments would not establish a useful supported interface.

Reopen launcher support when a host needs a concrete overlay, then verify that
specific composition and protocol boundary. There is no general overlay
validation project until that use case exists. OAR does not parse a few patch
fields and claim to have validated arbitrary native dynamic configuration.

A field sent directly as root `agentOptions.outputSchema` was ignored: the
provider request had no `response_format` or `structured_output` tool, and
plain text completed the turn. The positive control used
`subagents.startActivation` with the same schema and returned
`structured: { answer: 42 }` with `stopReason: completed`. This establishes a
native child mechanism, not a verified root-session mapping. Another native
integration may be possible; forwarding the root field unchanged is not one.

These refusals prevent a successful open or completed turn from implying that
an unverified option was applied. Native DSH owns composition and structured
child output; the adapter reports its supported boundary. This report and the
reproduction scripts preserve the evidence for the next implementation.

## Selected observations

Both versions produced these results in [selected.json](selected.json):

| Control | Observed result |
|---|---|
| Public `outputSchema` | `UnsupportedOptionError` before a model request |
| Root native schema field | Plain `not a JSON object`; native turn completed |
| Native child schema | `structured_output` declared; `{ answer: 42 }` returned |
| Public `launchArgs` | `UnsupportedOptionError` before a model request |
| First probe-only overlay | Provider instruction was `FIRST {{literal}}` |
| Resume with replacement overlay | Instruction was `RESUMED {{literal}}` |
| Resume without arguments | Neither literal marker remained |
| Missing overlay, bypassing refusal | Native exit 1, failed-to-read-overlay diagnostic, zero requests |
| Repeated `--profile`, separate or equals | Native exit 1: select a profile only once |
| `--from-default-profile acp` | Native exit 1: shipped profile cannot be a custom target |
| Overlay disabling `oar-dsh-bridge` | No ready frame in the three-second observation; composed dump has `disabled: true` |
| Overlay changing bridge `name` | Native keeps the original name; bridge ready, replacement plugin never loaded |
| Overlay enabling `acp` | Composed dump has `disabled: false`; bridge ready alone does not rule out a second transport |
| `--plugin-dir` | Native unknown-option error, not a plugin-directory setting |
| `--dump-config` | Prints configuration and exits 0 without a ready frame |

A truthy native patch `name` asserts the existing plugin's name rather than
renaming it; that sample does not demonstrate bridge replacement. The disabled
bridge conclusion comes from the composed native tree as well as the bounded
observation, not a timeout alone. No user prompt was sent in the conflict runs.

Each schema run made four synthetic provider requests. Each successful
launcher sequence made three. Missing-overlay and conflict runs made none.
[raw-manifest.json](raw-manifest.json) fingerprints retained local raw captures;
it contains no account identity fingerprints. Only cited fields and composed
rows are published. Full default prompts, disposable paths and unrelated frames
are omitted. Native diagnostics can echo argument paths; publication replaces
the disposable paths with placeholders.

## Native source and reproduction

Pinned sources are DSH
[0.2.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db)
and
[0.2.1-rc.5](https://github.com/deepseek-ai/deepseek-harness/tree/b830ec950faba0a46dda564be3e2d854afed94f1).
Relevant paths in those trees:

- `apps/cli/src/args.ts`: duplicate profile rejection, repeated patches and dump modes.
- `packages/bundle/acp-app/src/index.ts`: zero-option application command.
- `packages/boot/app-boot/src/config-schema/document.ts`: patch-name assertion and dynamic configuration metadata.
- `packages/subagent/subagent/src/manager.ts` and `structured.ts`: child setup attaches the structured runtime when its schema is present.

From the repository root, set `OAR_DSH_BIN` to each installed binary and run:

```sh
pnpm tsx experiments/dsh-option-boundaries/probe-output-schema.ts
pnpm tsx experiments/dsh-option-boundaries/probe-launch-args.ts
pnpm tsx experiments/dsh-option-boundaries/probe-launch-conflicts.ts
CI=1 pnpm run check
```

The scripts accept an optional output filename. The schema probe bypasses the
public refusal for the root control and invokes the native child API through a
fixture plugin. Launcher probes use [a separate experimental launch helper](launch.ts)
with OAR's actual bridge source; the production launcher does not accept these
arguments. The successful overlay probe checks native first-turn and resume
instructions. The conflict probe preserves native frames and composed config
without loading a real account. Existing declaration regressions assert the
public refusal before an executable can start.

Initial preparation failures are retained locally: the schema control first
looked for `structured` on a subagent-end event instead of the native activation
result, and the launcher fixture first inspected only `system` messages although
DSH emitted `developer`. The corrected controls read the actual native result
and both instruction roles. Neither preparation failure was evidence of an
adapter or native-runtime defect. An initial implementation forwarded arguments;
it was withdrawn after the conflict probes, before publication.
