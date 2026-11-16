# Codex 0.169.0 shared-process observations

Linux x64 observations use the native `codex-cli 0.169.0`, a disposable
`CODEX_HOME`, and a loopback scripted provider. They use no real login or
paid inference. macOS and Windows observations are pending. Production
Codex sharing remains disabled; this report does not enable an adapter.

[Selected evidence](codex-0.169.0-linux-selected.json) retains the result
of each native gate, the model readbacks, every exercised trust phase with
its actual MCP invocation and hook journal, and every resource window.
It also fingerprints the full local raw files. Machine paths, process ids,
thread ids, complete prompts and unused native frames are omitted.

## Native routing and lifetime

The [native probe](codex.ts) completes all nine observations on Linux:
message/cwd isolation, same-name MCP isolation, child attribution, loaded
resume, unsubscribe/resume, scoped background cleanup, interruption with a
surviving peer, concurrent unsubscribe/resume, and process exit with two
active threads. Assertions now check the previously collected cleanup,
interrupt and model outcomes explicitly. A wrong-owner terminate leaves
both process trees alive; the owning terminate removes only its own tree.

The [same-directory probe](same-directory.ts) also completes both process
placements and all four opposite per-session `bypass_hook_trust` controls.
The new persisted-trust experiment below does not set that bypass.

## Persisted hook trust: declared timing difference

The [persisted-trust probe](codex-persisted-trust.ts) discovers the native
hook key and content hash through `hooks/list`. It grants and revokes that
hash using `config/batchWrite`, `hooks.state`, `mergeStrategy: "replace"`,
and `reloadUserConfig: true`. It reads back the file and each loaded
thread's native hook list, then executes the actual same-name MCP tool in
A and B. Each process placement uses a fresh fixture with the same
disposable user configuration shared by its processes.

| Phase | Shared A | Shared B | Separate A | Separate B |
| --- | --- | --- | --- | --- |
| Initially untrusted | no hook | no hook | no hook | no hook |
| A grants and reloads | hook runs | hook runs | hook runs | no hook |
| Explicit reload through B too | hook runs | hook runs | hook runs | hook runs |
| A revokes and reloads | no hook | no hook | no hook | hook runs |
| Explicit reload through B too | no hook | no hook | no hook | no hook |

All 20 MCP invocations reached the intended server and their actual output
reached the provider. The journal contains one `PreToolUse` entry for each
"hook runs" cell and none for the other cells; native hook completions
report success. Positive grant controls make the empty journals meaningful.
Peer reloads are deliberate controls, not retries after a failed assertion.

This is a **declared difference**, not an equivalence pass or an admission
failure. Hook trust is persistent user-level configuration. A reload updates
all loaded threads in the receiving process; a separate process keeps its
old state until its own reload or reopen. The persisted grant/revocation
is the same in both placements. In particular, a shared peer observes a
revocation immediately. Native
[`reload_user_config_inner`](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server/src/request_processors/config_processor.rs#L401)
iterates that process's loaded thread ids. The native
[hook reload test](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server/tests/suite/v2/hooks_list.rs#L1446)
tests a loaded thread, but skips Windows; our cross-platform observation
must establish the Windows behavior independently.

The first local run collected these same successful native controls but
exited nonzero because its final assertion required equal shared/separate
outcomes. That original sample remains retained. The documented policy
now accepts this user-level reload timing difference, and the final probe
asserts its exact grant/revoke matrix while still reporting
`sameHookOutcomes: false`.

## Loaded resume model rule

A loaded, subscribed A thread running `gpt-5.1` receives
`thread/resume { model: "gpt-5.2" }`. Native readback stays `gpt-5.1`, and a
subsequent native-only diagnostic turn actually uses `gpt-5.1`. Applying
the production `codexOpenReadback` function to that reply yields
`ModelConfirmationError { requested: "gpt-5.2", reported: "gpt-5.1" }`.
The peer B still completes. After unsubscribe and resume, both readback
and provider request use `gpt-5.2`; the same readback guard accepts them.

The adapter rule is to preserve the typed refusal whenever native resume
does not confirm the requested model. A future pooled adapter must release
only the attempted open's lease, leaving the existing controller and peers
running; it must not kill the shared process, evict a live thread, silently
accept the old model, or send a prompt on behalf of the refused open.
Current production sessions still own isolated processes. This experiment
checks the readback function and native peer survival, not a production
shared `Session` implementation.

## Linux resources

The [resource probe](codex-resources.ts) runs cohorts in
isolated/shared/shared/isolated order, with 10 sessions per cohort, one
local-provider turn per session, a 5-second settling period and three
5-second idle windows. All four cohorts finish and clean up.

| Placement | Mean RSS across six post-turn windows | Mean CPU, one core = 100% |
| --- | ---: | ---: |
| Isolated | 1460.00 MiB | 0.8310% |
| Shared | 195.20 MiB | 0.1330% |

No window is a CPU lower bound from an exited child. The Linux sample
meets the lower-memory/no-higher-CPU resource condition; it does not
predict macOS, Windows, a real provider workload, or long-term idle cost.

## Reproduce

Use Node 24+, `pnpm install --frozen-lockfile`, and the exact native
`@openai/codex@0.169.0`. Set `OAR_CODEX_BIN` to its executable and run each
command, preserving earlier failed output instead of overwriting it:

```sh
pnpm tsx experiments/sharing/codex.ts
pnpm tsx experiments/sharing/same-directory.ts codex
pnpm tsx experiments/sharing/codex-persisted-trust.ts
pnpm tsx experiments/sharing/codex-resources.ts
```

The manual [workflow](../../.github/workflows/shared-runtime-evidence.yml)
pins 0.169.0, runs the new persisted controls as well, and retains all raw
artifacts even when a control fails. Per-thread child environments and
credential access are a separate investigation; no conclusion about that
boundary follows from these observations.

## Validation

`CI=1 pnpm run check` passed on base `82ea5310`: 4,385 unit tests
and 18 mock behavior cases. Type checking and lint passed. `actionlint`
accepted the manual workflow. The full local check log has SHA-256
`a5e34f3473607567145c9506a1610f413e38ae76daaf7b4a0ca6594e04974ac5`.
