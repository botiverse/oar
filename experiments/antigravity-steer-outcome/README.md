# Antigravity steer outcomes

Linux x64, native agy CLI 1.5.0, 2026-11-06. All model requests went to a
local scripted provider. No account login, paid inference or altered native
response was used. [Selected results](selected.json) retain the native error
codes and the OAR records before and after the fix.

## Results

The successful steer vendor regression now checks the original prompt too.
The second model request contains `AGY_INITIAL_TURN`, `AGY_STEER_INSIDE_LOOP`
and `echo:agy-steered`. The original prompt is retained in this measured
same-loop tool case. This does not establish every possible history or
provider mode.

| Control | Native result | Before | After |
| --- | --- | --- | --- |
| Invalid image steer, received before original completion | `-32602`; original later returns `end_turn` | Original completion preserved | Same |
| Same invalid steer, request delayed until original natural completion | Original `end_turn`, then `-32602` | Whole turn incorrectly failed | Original completion preserved; only the refused input is dropped |
| Valid steer, then kill its owned session worker after the original early reply | Original `end_turn`, then `-32603`; outer ACP process remains alive | Failed turn plus a false `runtime_refused` input drop | Failed turn, accepted input retained, no false input drop |

The second case deliberately delays the invalid request on the transport.
It reproduces the crossing deterministically with actual native replies;
it does not claim that an unmodified transport naturally produced this
ordering in this run. The relay changes no message bodies or responses.
Protocol regressions also cover both reply orders without relying on clocks.

The worker error says the serving process exited, but carries no structured
worker identity or exit category. The adapter does not classify it from that
text, claim that the outer process exited, or invent a successful outcome.
Its failed turn retains the native error with failure class `unknown`.
No claim is made about resuming that failed worker or a later prompt.

## Change

Antigravity recognizes the observed invalid-params code as a steer refusal
regardless of earlier prompt reply order. The shared ACP turn driver keeps
this refusal out of the turn outcome. A replacement execution failure that
settles the loop no longer also claims the input was refused.
Other ACP profiles retain their existing refusal policy. No public types,
capabilities, timeouts or busy gates change.

The initial worker lookup used only the main thread's procfs `children`
file and found no child. The retained probe uses the complete process table,
requires exactly one direct worker, then rechecks parent and child start
identities before signalling it. This is probe instrumentation, not product
process management.

## Reproduce

Set `OAR_ANTIGRAVITY_BIN` to the installed CLI 1.5.0 binary, then run:

```sh
pnpm tsx experiments/antigravity-steer-outcome.ts refusal
pnpm tsx experiments/antigravity-steer-outcome.ts worker-exit
pnpm tsx experiments/antigravity-steer-outcome/adapter.ts refusal
pnpm tsx experiments/antigravity-steer-outcome/adapter.ts worker-exit
```

An optional argument after the mode selects the output directory. The worker
controls use Linux process identities and signal only the worker started by
this probe. Raw wire output stays local because it contains temporary paths.
The published selection omits paths and process IDs.

The first-prompt retention check runs with the real CLI:

```sh
OAR_TEST=antigravity-aimock OAR_TEST_REQUIRE_AVAILABLE=1 pnpm vitest run sea-trial/vendor/antigravity-acp.vendor.test.ts
```

## Validation

Linux validation passed typechecking, lint, 3,605 unit tests and 18 mock
behaviors, all 16 behavior backends, all 12 Antigravity native vendor cases,
builds and a clean install of the packed packages. Both the raw and OAR
probes were rerun from the retained scripts; their selected outcomes match.
Removing the structured-refusal rule or restoring the unconditional input
drop makes the corresponding regression fail. Existing replay snapshots
remain unchanged. Windows and macOS results belong to the PR CI.

## Release-note draft

Fix Antigravity steering around prompt completion: a refused input cannot
turn a naturally completed original prompt into a failed turn. A worker
failure after an accepted replacement remains a failed turn without falsely
returning that input to the caller as `runtime_refused`. The steer regression
also verifies that the next model request retains the original prompt.
