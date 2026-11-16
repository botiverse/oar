# Codex 0.169.0 shared-process observations

Linux x64, macOS arm64 and Windows x64 observations use native
`codex-cli 0.169.0`, disposable `CODEX_HOME` directories and a loopback
scripted provider. They use no real login or paid inference. Routing,
lifetime, configuration and persisted-trust controls complete on all three
platforms. Actual child cwd/environment controls also complete on all three.
Linux and macOS satisfy the observations required for an adapter proposal;
Windows does not establish the CPU condition. Production Codex
sharing remains disabled; adapter enablement is a separate change.

Selected evidence for [Linux](codex-0.169.0-linux-selected.json),
[macOS](codex-0.169.0-macos-selected.json) and
[Windows](codex-0.169.0-windows-selected.json) retains the result
of each native gate, the model readbacks, every exercised trust phase with
its actual MCP invocation and hook journal, and every resource window.
It also fingerprints the full local raw files. Machine paths, process ids,
thread ids, complete prompts and unused native frames are omitted.

macOS and Windows ran in [workflow 43803690241](https://github.com/botiverse/oar/actions/runs/43803690241)
at `07e2e4efbb5a8d760f50130fa3bc420df1fc18ce`. Both jobs completed
successfully; that alone does not establish admission because the resource
probe also retains incomplete CPU windows. Full artifact SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| macOS arm64 | `00fb12dfd66021c0b145e7ce5fae1c1bc9a3170dd0e8438e69594eca3223de65` |
| Windows x64 | `c1d83f729af5ca5f2e2083b74e78804468aa33ce7a76558a16bb00a9b8244557` |

## Rule 5 checklist

| Required observation | Linux x64 | macOS arm64 | Windows x64 |
| --- | --- | --- | --- |
| Concurrent messages, cwd, MCP and child attribution | observed | observed | observed |
| Same-directory MCP, including reuse after close | observed | observed | observed |
| Later project/user configuration and per-session hook trust | observed | observed | observed |
| Persisted hook grant/revoke | declared reload timing difference | same difference | same difference |
| Actual tool, stdio MCP and hook cwd/environment vs isolated | observed | observed | observed |
| Cancellation, peer survival and scoped cleanup | observed | observed | observed |
| Loaded resume and typed model refusal | observed | observed | observed |
| Concurrent unsubscribe/resume and shared process exit | observed | observed | observed |
| Lower memory without higher CPU | observed | observed | incomplete CPU windows |

Linux and macOS have the native observations required for an adapter proposal.
Windows still lacks the no-higher-CPU resource result. This table does not enable sharing or
verify an OAR pooled Session implementation.

## Native routing and lifetime

The [native probe](codex.ts) completes all nine observations on each platform:
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

All 20 MCP invocations per platform reached the intended server and their actual output
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
tests a loaded thread, but skips Windows. The Windows native probe above
independently observes the same grant/revoke behavior and successful hooks.

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

## Actual child cwd and environment

The [child probe](codex-execution-environment.ts) gives both placements the
same process-level marker, uses distinct A/B session directories, and
executes real tools, stdio MCP servers and `PreToolUse` hooks. MCP receives
the marker through its native inherited-variable allowlist, not a separate
inline override. Each placement observes two tool commands, two MCP child
starts and four hook invocations. Every child on all three platforms uses its
session's directory and receives the expected marker, with no native hook
failures ([Linux](codex-0.169.0-linux-environment-selected.json),
[macOS](codex-0.169.0-macos-environment-selected.json),
[Windows](codex-0.169.0-windows-environment-selected.json)).

The first probe attempt serialized a tool content array as `[object Object]`
and failed its own marker check. The retained failed sample is not a native
counterexample. Serializing the content correctly produces the result above.
The macOS/Windows follow-up is [run 43809745923](https://github.com/botiverse/oar/actions/runs/43809745923)
at `eb6c55240b121d0acbd626753a01ddd82729b763`. Its macOS job succeeds; the
Windows environment step succeeds after the resource step fails. Distinct per-thread environments
and credential access are a separate investigation: identical launch
environments do not prove that different agent credentials can share safely.

## Resources

The [resource probe](codex-resources.ts) runs cohorts in
isolated/shared/shared/isolated order, with 10 sessions per cohort, one
local-provider turn per session, a 5-second settling period and three
5-second idle windows. All four cohorts finish and clean up.

| Platform | Placement | Mean RSS across six post-turn windows | Mean CPU, one core = 100% | Lower-bound CPU windows |
| --- | --- | ---: | ---: | ---: |
| Linux | Isolated | 1460.00 MiB | 0.8310% | 0/6 |
| Linux | Shared | 195.20 MiB | 0.1330% | 0/6 |
| macOS | Isolated | 1009.36 MiB | 0.7933% | 0/6 |
| macOS | Shared | 125.30 MiB | 0.0992% | 0/6 |
| Windows, original | Isolated | 1309.97 MiB | incomplete | 4/6 |
| Windows, original | Shared | 168.15 MiB | incomplete | 1/6 |

Linux and macOS meet the lower-memory/no-higher-CPU resource condition.
Windows's original five incomplete windows remain in the selected evidence;
this report does not turn their lower-bound averages into an admission pass.
All four cohorts on each platform finish and clean up. These samples do not
predict a real provider workload or long-term idle cost.

The Windows-only resource follow-up uses a fixed 30-second settling period
and 15 one-second windows per cohort, in the same four-cohort order with ten
sessions. It retains every window and fails if any CPU window is incomplete.
It does not select a passing subset or retry individual windows. Raw evidence
now includes exited process identities to diagnose gaps. A two-session Linux
0.169.0 run validates this sampling path only; it is not the Windows resource
result. An earlier local control accidentally used PATH version 0.162.0;
that sample is retained separately and contributes no 0.169.0 evidence.

### Windows follow-up: CPU comparison remains unresolved

The follow-up retains [all 60 windows](codex-0.169.0-windows-resources-followup.json).
Five CPU windows are lower bounds, all in the two isolated cohorts (4 and 1).
Both shared cohorts have 15 complete windows. The workflow fails its explicit
incomplete-window assertion, retains all four cohorts, and does not rerun.
The requested windows are one second; each retained `elapsedMs` includes
the actual sampling duration and process-table read overhead.

A shared value no higher than an isolated lower bound would conservatively
establish the comparison for that pair, because the true isolated CPU can
only be higher. Compare matching window indices within the two successive
isolated/shared pairs without omitting any window:

| Pair | Window | Isolated CPU % | Shared CPU % | Isolated is lower bound | Shared <= isolated observation |
| --- | ---: | ---: | ---: | --- | --- |
| 1 | 1 | 0.768508 | 0.000000 | no | yes |
| 1 | 2 | 3.773299 | 0.000000 | no | yes |
| 1 | 3 | 0.756225 | 0.777008 | yes | no |
| 1 | 4 | 54.724015 | 0.000000 | no | yes |
| 1 | 5 | 21.511319 | 0.000000 | yes | yes |
| 1 | 6 | 17.358392 | 0.000000 | no | yes |
| 1 | 7 | 0.772330 | 0.000000 | no | yes |
| 1 | 8 | 2.267043 | 0.000000 | no | yes |
| 1 | 9 | 1.426481 | 0.000000 | no | yes |
| 1 | 10 | 18.941243 | 0.000000 | yes | yes |
| 1 | 11 | 22.475545 | 0.000000 | no | yes |
| 1 | 12 | 15.696571 | 0.000000 | no | yes |
| 1 | 13 | 28.587463 | 0.776160 | no | yes |
| 1 | 14 | 34.145682 | 0.000000 | yes | yes |
| 1 | 15 | 11.800219 | 0.000000 | no | yes |
| 2 | 1 | 0.768972 | 0.000000 | no | yes |
| 2 | 2 | 44.846726 | 0.000000 | no | yes |
| 2 | 3 | 27.243197 | 0.000000 | yes | yes |
| 2 | 4 | 46.045016 | 0.000000 | no | yes |
| 2 | 5 | 8.938668 | 0.000000 | no | yes |
| 2 | 6 | 4.941806 | 0.000000 | no | yes |
| 2 | 7 | 8.073632 | 0.000000 | no | yes |
| 2 | 8 | 41.804181 | 0.000000 | no | yes |
| 2 | 9 | 1.188313 | 0.000000 | no | yes |
| 2 | 10 | 0.000000 | 0.779494 | no | no |
| 2 | 11 | 1.440820 | 0.782716 | no | yes |
| 2 | 12 | 42.025789 | 0.000000 | no | yes |
| 2 | 13 | 16.821845 | 0.778414 | no | yes |
| 2 | 14 | 15.428848 | 0.000000 | no | yes |
| 2 | 15 | 33.061359 | 0.000000 | no | yes |

Pair 1, window 3 is unresolved: shared 0.777008% exceeds the isolated
lower bound of 0.756225%. Pair 2, window 10 has complete observations but
shared 0.779494% exceeds isolated 0%. The other 28 pairs satisfy the
comparison. The evidence does not establish the required CPU condition for
Windows; lower average memory alone does not admit it. No sample is dropped,
and these sequential idle observations do not prove a causal CPU regression.

Full follow-up artifact SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| macOS arm64 | `e7ac389fbc06cc394a96f8327a1dee76bb48d23944b45500f1b19c7e290433f2` |
| Windows x64 | `fc745289d0d80214b4f82310cc21e4853d641397f3d26ddd94953cb2b2d69370` |

## Reproduce

Use Node 24+, `pnpm install --frozen-lockfile`, and the exact native
`@openai/codex@0.169.0`. Set `OAR_CODEX_BIN` to its executable and run each
command, preserving earlier failed output instead of overwriting it:

```sh
pnpm tsx experiments/sharing/codex.ts
pnpm tsx experiments/sharing/same-directory.ts codex
pnpm tsx experiments/sharing/codex-persisted-trust.ts
pnpm tsx experiments/sharing/codex-resources.ts
pnpm tsx experiments/sharing/codex-execution-environment.ts
# Windows follow-up, kept separately from the original sample:
pnpm tsx experiments/sharing/codex-resources.ts oar-trial-run/codex-sharing-resources-short 10 short-windows
```

The manual [workflow](../../.github/workflows/shared-runtime-evidence.yml)
pins 0.169.0 and retains all raw artifacts even when a control fails.
`codex_followup_only=true` runs child environment controls on the requested
platforms and the shorter resource comparison on Windows only. It preserves
the original routing, trust and resource samples. The
[selection script](select-codex-0169.py) selects cited fields from an unpacked
artifact; `--environment` selects one child-evidence file and `--resources`
selects every window from one resource-evidence file.

## Validation

The initial `07e2e4ef` branch passed `CI=1 pnpm run check`: 4,385 unit tests
and 18 mock behavior cases. The follow-up on base `2a98d63d` passed 4,389
unit tests and 18 mock behavior cases, including type checking and lint.
`actionlint` accepted the manual workflow. After rebasing on `f249dbe9` and
adding the follow-up evidence, the final check passed 4,405 unit tests and
18 mock cases; log SHA-256
`c06502e1ce5512791fc3fef0d16f5c3dfbadf4eba8ffdc18862324495f94e850`.
The Linux 0.169.0 two-session sampling control retained all 60 complete
windows across four cohorts; none is a CPU lower bound.
