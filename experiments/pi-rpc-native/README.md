# Native Pi RPC

Run `pnpm tsx experiments/pi-rpc-native/probe.ts [output-directory]` from the
repository root. It launches Pi's own exported RPC entry against a local
scripted provider in a temporary home, then repeats the session in a new
process. No account or paid model request is used.

On October 23, 2026, Pi 1.4.0 (upstream v1.4.0, commit `4a080252`) accepted
`get_state` without a handshake, returned the prompt disposition, preserved
session id, selected model, thinking and prior conversation across processes,
and returned context fullness in `get_session_stats.contextUsage`. Startup
`--thinking high` did not rewrite the previous global `low` setting. EOF closed
the process with native shutdown; SIGTERM by itself uses exit code 143.

Relevant native sources at that revision are `packages/coding-agent/src/main.ts`,
`src/modes/rpc/rpc-mode.ts`, `src/modes/rpc/rpc-types.ts`,
`src/core/agent-session.ts`, and `src/core/extensions/runner.ts`.
The protocol does not promise compatibility between versions.

The probe writes raw native frames, query facts and scripted provider requests,
with temporary paths replaced. The committed vendor tests turn these findings
into assertions through OAR. Run both locations:

```sh
OAR_TEST=pi-aimock pnpm vitest run sea-trial/vendor
OAR_TEST=pi-rpc-aimock pnpm vitest run sea-trial/vendor
OAR_TEST=pi-rpc-aimock pnpm sea-trial
```

The RPC-specific tests cover restored extension activation and unresolved
pending names, current exclusions, current builtin defaults and user overrides,
handled input, real MCP calls, crashes, EOF shutdown, descendant cleanup,
private configuration removal, host-selected executable versions, per-turn
context stats and a bundled host with no adjacent OAR source/dependencies.
The SDK-specific assertions are retained. The portable context assertion also
pins the extra native RPC stats response after `agent_settled` rather than
pretending it is an SDK event.

Initial implementation failures were retained locally: unknown model ids were
accepted by native CLI startup, fixed by checking the child's native registry;
combining EOF and SIGTERM reentered shutdown, fixed by waiting for EOF first;
a raw SDK VERSION was polluted by the host's PI_PACKAGE_DIR, fixed by reading
the dependency version. These are adapter observations, not claimed upstream
fixes. Native extension default restoration remains different between the
locations; see [Pi runtime](../../docs/runtimes/pi.md#optional-native-rpc-process).

## Private prompt files

On October 26, 2026, the dedicated
[prompt-file tests](../../sea-trial/vendor/pi-rpc-prompt-files.vendor.test.ts)
verified Pi 1.4.0 through both the bundled RPC entry and an installed CLI.
Each system and appended prompt exceeds 44,000 characters and contains many
newlines. The scripted provider receives both complete bodies without a private
file path; the child arguments contain only paths. POSIX files have mode 0600
inside a 0700 directory. Disposal, native startup failure and a later native
process crash all remove the private files. Linux passed locally; these tests
also run in the Windows and macOS RPC jobs.

Pi's `src/core/resource-loader.ts` `resolvePromptInput` falls back to the input
string when a path is missing or cannot be read, with only a warning for a read
failure. OAR verifies each private file before spawning the session process and
retains it until process exit. Separate unreadable system-file and append-file
controls fail explicitly, start no session process, send no provider request
and leave no private directory. The original four native regressions failed
before the fix; all six controls pass with file arguments and the readback guard.
