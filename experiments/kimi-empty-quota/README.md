# Kimi empty quota response

November 18, 2026, Linux x64, native Kimi 2.6.3 and OAR 0.116.0.
The service returned a successful empty object for one dedicated test
account. Native interactive `/usage` displayed **Plan usage** followed by
**No usage data available.**, without an error. OAR instead threw
`Kimi usage response contains no usable quota windows`.

## Observation

[`selected.json`](selected.json) retains only the observations cited here:

- A native interactive `/usage` read at 06:52 UTC received a successful
  response with no top-level fields. The TUI displayed the no-data message,
  did not display an error or free-plan assertion, and exited normally.
  Credentials remained unchanged and no refresh request was made.
- A planned OAR usage read at 07:05 UTC independently confirmed the response
  was an object with no fields, rather than an array or `null`. Refresh had
  succeeded and persisted before OAR's quota projection threw.

The native process observer wrapped `fetch` and the existing response's
`json` method, passed their results through unchanged, and retained only
timings, field names and booleans. It made no additional requests. The TUI
driver retained known static-label matches, not the terminal transcript.
Instrumentation adds local observation overhead. No model prompt was sent;
account identifiers, credentials and response values were not recorded in
these selected observations.

## Native meaning and mapping

At native commit `b0de2fbd2de04d87689225aafd3912e5d193b62d`,
[`parseManagedUsagePayload`](https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/packages/oauth/src/managed-usage.ts#L108)
maps absent `usages` to an empty quota collection. The CLI's
[`loadManagedUsageReport`](https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/apps/kimi-code/src/tui/commands/info.ts#L259)
uses the parsed quota rows, and
[`buildManagedUsageSection`](https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/apps/kimi-code/src/tui/components/messages/usage-panel.ts#L117)
renders the no-data message when there are no rows.

Both OAR readers now map absent or empty quota collections to
`{ kind: "unsupported", reason: "quota_unavailable" }`. The direct reader
still recognizes its existing `usage` and `limits` format; valid rows remain
available. Nonempty quota collections with no usable rows still throw,
as do malformed collection types. The Web projection sees Kimi's parsed
response, so it cannot recover fields already discarded by native parsing.
This result asserts only that no quota configuration was exposed. It does
not identify a plan, promise request capacity, or report a zero-used window.

## Regression checks

Synthetic unit cases cover the empty and malformed branches of both
projections and the direct public reader. The native vendor control sends
an empty success response from an isolated local server, requires one
refresh to persist, expects `quota_unavailable`, and confirms no optional
profile lookup or surviving native processes.

```sh
pnpm vitest run tests/kimi
OAR_TEST=kimi-login OAR_KIMI_LOGIN_COMMAND=/absolute/path/to/kimi pnpm vitest run sea-trial/vendor/kimi-expired-usage.vendor.test.ts
```

These regression commands use synthetic credentials and a local provider;
they do not repeat the real-account observation.
