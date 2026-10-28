# Claude permission modes, 2026-10-28

This report records the native investigation before adapter support. At
that point OAR always supplied bypass and refused `--permission-mode`. The
subsequent implementation accepts four noninteractive modes through launch
arguments; see [current behavior](../../docs/runtimes/claude.md#tools-permissions-and-extensions).
The observations below retain the original native fixtures and limits.

## Reproduce

```sh
OAR_CLAUDE_BIN=/absolute/path/to/claude pnpm tsx experiments/claude-permissions/probe.ts
```

The probe starts the real executable against a local scripted Anthropic
provider, in disposable HOME/config/workspace directories. It inherits PATH
but no account credentials, disables hooks and supplies an empty strict MCP
configuration. It writes only inside the fixture. No real login or model
quota is used. Output is under `oar-trial-run/claude-permissions`: one JSON
per case and `report.json`. `OAR_PERMISSION_OUTPUT` changes that directory;
`OAR_PERMISSION_CASE` filters labels by regular expression, or `resume` runs
only the resume group. Raw settings are not retained. Private native/provider
traces stay in that ignored directory; the observations below are the report.

Observed on Linux x64 with Claude 2.1.311, native package
`@anthropic-ai/claude-code-linux-x64@2.1.311`, executable SHA256
`86dc1fcc69498159eaf15f446613e847010f9036bfbbdffd4c49350be8489ada`.
This does not claim macOS/Windows verification or real-model classification.

## Native observations

The Bash fixture runs Node to create a file; the Write fixture creates a
file directly. Both use fresh paths in the workspace. All non-waiting cases
ended with a native success result, including denied-tool cases; the tool
error and `permission_denials` describe the denial, not a failed turn.

| Mode, without bypass | Bash, no permission prompt tool | Write, no permission prompt tool | Bash with explicit stdio prompt tool |
|---|---|---|---|
| `dontAsk` | denied | denied | denied without a host request |
| `default` | denied | denied | `can_use_tool`; no result in 4 s without an answer |
| `acceptEdits` | denied | file created | `can_use_tool`; no result in 4 s without an answer |
| `plan` | classifier-dependent, below | denied | classifier-dependent; no host request in these fixtures |

The same matrix with `--permission-prompts none` preserved the mode's
already-allowed operations, including Write under `acceptEdits`. It denied
the pending default/acceptEdits Bash approval locally, even when
`--permission-prompt-tool stdio` was present. No `can_use_tool` was sent in
those cases. Without an explicit prompt tool, adding `none` did not change
these observed outcomes. OAR currently supplies neither a permission prompt
tool nor an SDK URL. The native default `host` target alone is not enough
to request an answer over stdio.

Controls: the usual bypass created the Bash file. With default + stdio, a
native `control_response` carrying `behavior: allow` and `updatedInput`
created it; `behavior: deny` did not. Both answered controls completed. The
unanswered cases were terminated after a measured four-second wait; that
observation is not a proof of an infinite hang.

Plan's Bash permission path consulted an additional model classifier. A
scripted severity 0 answer allowed the write with and without `none`; a
scripted severity 90 answer denied it after two classifier requests, without
a host prompt. These are controlled protocol outcomes, not judgments a real
model is guaranteed to make. In particular, `plan` is not an OS boundary
preventing all filesystem writes, and `none` does not turn it into one.

The first matrix used an ordinary completion for classifier requests. Plan
Bash then made ten classifier attempts and denied the tool because its
classifier responses were invalid. That first denial is a fixture failure,
not evidence of plan-mode enforcement. The final probe distinguishes the
classifier request and returns its native severity format; both outcomes
above come from that corrected fixture. An intermediate severity 3 control
also allowed the write: the native scale is 0-100, with a boundary at 50;
the blocking control therefore uses 90.

## Resume

The same native session id survived all five Write invocations. Native
`system/init.permissionMode` and the actual file side effect agreed:

| Invocation | Reported mode | New file |
|---|---|---|
| Create with `acceptEdits`, `none` | `acceptEdits` | created |
| Resume, omit mode, retain `none` | `default` | absent |
| Resume with `plan`, `none` | `plan` | absent |
| Resume, omit mode after plan, retain `none` | `default` | absent |
| Resume with `acceptEdits`, `none` | `acceptEdits` | created |

A separate default + stdio session denied Bash with `none`. Resuming the
same id with the same mode/stdio target but omitting `none` sent a host
permission request and did not finish within the four-second observation.
Both the desired mode and prompt target must be supplied again by a host
that needs the same behavior. These are empty-configuration fixtures, not
a promise to override every native saved/configured policy. Before the first turn and after it completed, `get_settings` returned
`effective`, `sources` and `applied`; its applied fields were model, effort,
advisor and the three ultracode fields, with no current permission mode.
A separate control configured `permissions.defaultMode: acceptEdits` but
launched with `--permission-mode plan`. The effective configuration still
reported acceptEdits before and after the turn, while init reported plan
and Write was denied. Configured defaultMode is not an applied-mode readback.
The embedded `get_settings` handler at byte 277590227 and `PJr` at byte
240282401 confirm that distinction.

The actual mode is available in Claude's `system/init.permissionMode` when
it starts a turn, including the first turn after resume. OAR already retains
that native frame verbatim; hosts can inspect it to confirm the resumed
mode. It is not available through this query before the first turn. No new
public event or inferred opening record is added.

## Source and OAR behavior

[src] In the pinned executable's embedded print-mode code, `TK` at byte
277622849 chooses `createCanUseTool` only when the prompt tool is `stdio`
and permission prompts are not `none`. Its `none`/absent-tool branch keeps
native permission evaluation and hook handling; `none` converts a remaining
ask into a local denial. The CLI option defaults to `host` at byte 258976069.
`KKn` at byte 248523539 resolves an SDK URL to stdio, otherwise uses the
explicit permission prompt tool. These identifiers/offsets identify this
binary only; they are not interfaces OAR should import or patch.

[src + regression] OAR's [Claude session profile](../../packages/oar/src/runtimes/claude/session.ts)
deliberately has no `permissionResponse`. The shared stream-json handler
records a native permission frame plus a `toApp` request, and writes an
answer only for profiles that supply that callback. Claude does not silently
allow, deny or acknowledge such a request. `Session` has no public answer
method. A [regression](../../tests/claude/claude-permission-request.test.ts)
feeds a native-shaped request through the actual Claude adapter and checks
both the public record and absence of a reply. The prior blanket statement
in `docs/design/chat-ui.md` about adapters automatically answering was too
broad; it is corrected in this research change.

## Options for a maintainer decision

1. A small opt-in could admit the four investigated modes only together with
   `--permission-prompts none`, omitting OAR's bypass when that pair is
   supplied. Keep rejecting interactive prompt targets and unknown/missing
   mode values, handle both flag spellings, and validate before spawn. This
   uses native denial behavior without introducing host approval. Its promise
   is no wait for a host permission answer, not that hooks, model requests,
   tools or MCP cannot wait. Permissions and user rules still belong to
   Claude. A narrower first step is `dontAsk` + `none` only; that excludes
   useful native edit/plan policies but gives hosts the DSH use case.
2. Supporting interactive modes needs an explicit approval API, ownership of
   each request id, response records, cancellation/exit behavior and a host
   policy for queued or unanswered requests. Simply dropping the bypass
   does not provide this API, and automatically granting a request defeats
   the host's tighter policy. This is a larger Session design decision.

Recommendation for discussion: use the first option if the immediate need
is DSH's noninteractive restriction; keep the default bypass unchanged and
require resupplying the flags on resume. Do not implement the second option
as an incidental launchArgs relaxation. That research change implemented no option; the current adapter policy is
linked above.
