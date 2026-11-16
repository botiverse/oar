# Cursor SDK 1.4.0 steering

November 16, 2026, Linux x64. The November 15 [type check](../runtime-version-checks/2026-11-15.md#cursor-140)
failed because SDK 1.4.0 added a queued object to `Run.steer`'s common return
type. The adapter now accepts that shape; the real 1.4.0 module compiles
against `CursorSdk`, and OAR's optional peer and CLI pin are 1.4.0.

## Ownership and observation

`complete_delivered` remains accepted and `revert_to_followup` remains
refused. `{ outcome: "queued", run? }` is accepted with
`native: { ack: "queued" }`: the SDK owns the input, so a caller must not
resend it. OAR does not observe the optional cloud run. Its progress,
completion, and cancellation are outside the session's recorded evidence.
The child process bridge forwards only the acknowledgment and never reads
or serializes the optional run.

The stand-in regression runs in both execution modes, with and without a
returned run. A throwing `run` getter proves the run is untouched, including
by serialization. The original turn still ends as aborted after cancellation;
the next explicit prompt starts the second SDK run, without a duplicate
follow-up. On the original product code the two cases fail: in process the
object is refused, and the subprocess proxy rejects its shape. With the fix,
all 152 focused Cursor tests pass. Cloud execution itself was not exercised.

## Native local result

One real-account local SDK run used an existing login and `gpt-5.4-nano`.
No retries were needed. At a native `tool-call-started` for the requested
shell command, before its completion notification, `Append MANGO.` was
steered. The SDK returned `complete_delivered`, echoed the input, and ended
the same run with `ALPHA MANGO.`. Calling the native run's `steer` after
completion returned `revert_to_followup`.

The shell command requested `sleep 8; echo ALPHA`; its tool completion
arrived after about 362 ms with empty output. Cursor moves an active shell
to the background on steering, as documented in the runtime page. This
probe establishes the acknowledgment timing, not that the shell stayed
foreground for eight seconds or that its output produced the final text.

Native usage was 17,001 input tokens (including 7,680 cache-read tokens) and
300 output tokens (including 213 reasoning tokens), 17,301 total.
[Selected evidence](selected.json) retains the two acknowledgments, the
relevant deltas, the type-check result and fingerprints of the full local
logs. Only the echoed agent identifier is replaced with `<agent>`; the
unselected raw deltas are retained locally and are not published.

## Reproduction

No account or inference is needed for the type and stand-in checks:

```sh
pnpm tsx experiments/runtime-version-checks/cursor-sdk-check.ts node_modules/@cursor/sdk
pnpm exec vitest run tests/cursor
```

The native probe spends real account quota and is deliberately outside CI.
With an authorized existing SDK login:

```sh
pnpm tsx experiments/cursor-sdk-1.4/native-steer.ts node_modules/@cursor/sdk /tmp/cursor-steer-evidence
```

Use a fresh output directory for each round. It retains native deltas and
results, uses an isolated temporary working directory, and closes the agent.

The complete local gate passed type checking, lint, 4,373 tests and 18 mock
behavior cases. The initial lint failures were confined to the new probe
and test formatting and are retained locally. Both package builds and the
packed-host install check passed. The first packed check hit the unchanged
15-second deadline in the native model-list call. The same installed host
then returned `ok`, and a fresh complete packed install passed. This does
not identify the timeout cause; the original failure is retained locally. Native cloud, macOS and
Windows execution were not run for this probe.
