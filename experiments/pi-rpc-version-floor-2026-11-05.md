# Pi RPC explicit-command version floor

OAR built with Pi 1.5.0 successfully used explicit Pi CLI 1.4.0 and 1.5.0
on Linux x64 against local scripted providers. This supports a stable 1.4.0
minimum for `createPiRuntime({ execution: "subprocess", command, args })`.
The default bundled entry still requires the exact dependency version.
No account or external model was used. npm `latest` was 1.5.0 when checked
on November 5, 2026.

| Selected path | Vendor suite | Behavior suite |
| --- | --- | --- |
| Explicit CLI 1.4.0, OAR dependency 1.5.0 | 95 passed | 17 passed, 2 capability skips |
| Explicit CLI 1.5.0, OAR dependency 1.5.0 | 95 passed | 17 passed, 2 capability skips |
| Default bundled 1.5.0 | 95 passed | Covered by ordinary CI |

The vendor selection applies to the shared Pi fixtures, native RPC sessions,
project resolution, private prompt files, diagnostics and native reader
fixtures. Deliberately missing/custom commands and bundled-host controls keep
their own command selection. Thus the totals describe the suite, not 95
identical launches of the explicit CLI. These results cover process controls,
MCP, resume, manual compaction, readers and ordinary scripted behavior, not a
real provider or Windows/macOS execution of the older CLI.

Launch and private extension-ready checks use one guard. Unit regressions
cover older, equal, newer, missing and malformed versions at both boundaries.
The command probe can report 1.5.0 while the private extension reports another
version, ensuring the second boundary is independently exercised. Five
mutations are caught: restoring exact-match admission, removing the floor,
removing parsing validation, skipping the extension check, and loosening the
default bundled check. The 1.6.0/2.0.0 admission cases are protocol fixtures,
not claims of native compatibility with unreleased versions.

## Reproduce

Keep OAR's dependency installed normally. Obtain the desired Pi CLI in a
separate directory, then run both commands with the same selection:

```sh
OAR_TEST=pi-rpc-aimock OAR_PI_RPC_COMMAND=node \
  OAR_PI_RPC_ARGS='["/absolute/path/to/pi/dist/bundle/cli.js"]' \
  pnpm vitest run sea-trial/vendor
OAR_TEST=pi-rpc-aimock OAR_PI_RPC_COMMAND=node \
  OAR_PI_RPC_ARGS='["/absolute/path/to/pi/dist/bundle/cli.js"]' \
  pnpm sea-trial
```

Omit `OAR_PI_RPC_COMMAND` and `OAR_PI_RPC_ARGS` for the bundled control.
The suite's isolated homes use synthetic credentials. Daily inspection uses
the newest explicit CLI in addition to the bundled baseline and retains any
new differences; a newer version passing admission does not imply that it
passed these controls.

## Release note

Pi subprocess hosts may supply a stable Pi CLI version 1.4.0 or newer without
matching OAR's embedded Pi release exactly. The version probe and the running
extension enforce the same minimum. Invalid or older versions fail explicitly
with `RuntimeFailureError` (`failure: "invalid_request"`) naming the actual
and required versions. The default bundled path is unchanged.
