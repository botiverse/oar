# Claude remote limit-reset text

Claude Code can replace its built-in limit-reset labels using the remote
`tengu_cedar_ember` feature. On Linux, OAR's existing driver already rejects
changed confirmation labels promptly on native 2.1.322 and 2.1.326. No
product change is needed for this case.

## Reproduce

With Linux, `script`, OpenSSL and either official native executable:

```sh
pnpm tsx experiments/claude-reset-remote-text/probe.ts /absolute/path/to/claude
```

Each case creates an isolated HOME, synthetic stored OAuth credentials,
completed onboarding and an empty project. The config has no cached feature
payload. A local HTTPS proxy serves the actual remote-evaluation response
and usage grant; it never forwards requests. The altered response changes
`confirmTitle` and `confirmYes`, while the control returns only `enabled`
and `version`, leaving native default text in use. The native terminal is
then driven by the unmodified OAR driver at main c2b42d55.

The test asserts that the CLI fetched the remote flag and native usage,
rendered the expected labels, and sent zero redemption requests. The host
usage/consent prerequisites are synthetic inputs; the CLI's own flag and
grant fetch are real requests to the local server. Certificate trust and
proxy settings are child-scoped, and no real credentials are inherited.
Cleanup kills the terminal process tree and removes the temporary HOME.

## Observed boundary

[Selected results](selected.json) retain each result, keys, elapsed time,
confirmation text and request counts.

| Case | Result | Input after the dialog opens |
| --- | --- | --- |
| Native default text, inspect | Weekly reset `available`, count 2 | Esc |
| Altered remote title and Yes label, inspect | Weekly reset `unknown`; inspection stops at `dialog` | Esc only |
| Altered remote title and Yes label, redeem | `{ kind: "unknown" }`, step `dialog` | Esc only |

Both altered operations return within the probe's 20-second bound, well
before the supplied 75-second call deadline. The selected timings include
startup and folder trust, not only dialog recognition. No Enter reaches a
changed dialog and no redemption endpoint is called. The default control
asserts only weekly recognition; it does not require later kinds to be
queried after cancellation, and any unqueried states remain in the output.

`startup_failed` would misdescribe this case: startup succeeded and the
command was submitted. OAR preserves the existing `unknown` result because
it cannot infer what an unrecognized native command did. For inspection,
the result is `inspected` with per-kind `unknown`, rather than pretending
that no reset exists. The unchanged-dialog control uses inspection, never
redemption, so this experiment does not spend even a synthetic reset.

The native UI makes a startup model request in each measured case, answered
by the local backend. These measurements do not make inspection a free or
pollable read. The first-run onboarding problem is separate:
[Claude runtime contract](../../docs/runtimes/claude.md#limit-resets).
