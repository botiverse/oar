# Qoder catalog selectors and init names

Observed on 2026-10-29 with qodercli 1.1.78, Linux x64, on xxwork using its
existing login. No login flow, logout or model prompt was submitted. Catalog
queries can contact account services; this is not an offline probe.

```sh
OAR_QODER_BIN=/path/to/qodercli pnpm tsx experiments/qoder-native/model-selection.ts --verify-open
```

The [probe](model-selection.ts) saves model catalog fields and an allowlist
of applied settings in `oar-trial-run/qoder-model-selection/report.json`.
It omits the initialize account payload, settings sources, effective
configuration and native stderr. The output directory is ignored by Git.

## Native evidence

Both `get_models` strategies returned 15 entries. Two were enabled for the
current account. Every enabled selector was opened natively, alongside the
existing `efficient` test selector and omission. Each row used a fresh process.

| Requested `--model` | Init `model` | Selected catalog `serverModel.display_name` | Applied settings |
| --- | --- | --- | --- |
| `qfmodel` | `Qwen3.8-Flash` | `Qwen3.8-Flash` | `effort: null`, `ultracode: false` |
| `dfmodel` | `DeepSeek-Flash` | `DeepSeek-Flash` | `effort: null`, `ultracode: false` |
| `efficient` | `Efficient` | `Efficient` | `effort: null`, `ultracode: false` |
| omitted | `Qwen3.8-Flash` | not requested | `effort: null`, `ultracode: false` |

The enabled rows' `modelId` equals `value`; it does not provide the init
name. Their top-level `displayName` also happens to match init in this sample,
but the implementation uses the underlying server field identified by source.
The selector is still the value callers must pass to `--model`.

[src] The executable's bundled JavaScript contains the headless
`get_settings` handler, which constructs `applied` with only `effort` and
`ultracode`. Its init projection resolves a model key through the model
manager and reads `display_name`, falling back to the input key when absent.
The catalog serializer retains that server model under `serverModel`.
This gives an exact native relationship, without deriving a name from text.

[src] `fetchStrategy === "live"` selects the live branch; other values use
the cache branch. Cache is the default behavior, not a promise of no network:
the handler can wait for a catalog when empty, refresh a stale shared cache
in the background, and load external-provider catalogs. No strict offline
strategy was found in this handler. The live observation confirms both
strategies answer; no network trace was collected to claim that either one
made zero requests in this run.

[env] Separate query timings after initialization were 5.246, 6.642, 5.338
and 6.698 ms for cache, across the omitted, `qfmodel`, `dfmodel` and
`efficient` rows. The omitted row's live control took 463.262 ms. These are
single samples per row, on an existing login with warmed local state; they
exclude process initialization and do not bound cold or remote work. OAR
uses cache for the additional confirmation query to reuse the session's
catalog, followed by one live read only if the selected entry or native name
is missing. Each read has the normal 30-second control deadline. Public
`listModels()` keeps its existing live read.

## OAR regression

The old strict comparison between the selector and init name rejected the
unit round trip at `qfmodel` with `Qwen3.8-Flash`. The replacement preserves
direct matches. For a mismatch it reads the same process's cached catalog,
finds the exact selector, and accepts only an exact match with that entry's
native resolved name. A missing entry or native name gets one live lookup;
if still absent, opening is refused. A similar or different name refuses
immediately, even if a live lookup might report another value. Failed and
timed-out catalog queries close the process without retrying. `model()` keeps
the native init name, and private catalog fields remain outside the stream.

[env] A public API comparison against unchanged main at `633bd68` rejected
both enabled ids with the respective init names above. With this change,
`listModels()` returned both ids with their native `resolvedId`; passing each
id unchanged to `session()` opened successfully, and `model()` returned that
resolved name. Both sessions were disposed without sending a prompt.

Unit coverage passes every listed fixture id to `session()`, using separate
selector, display label and resolved name values. Native replay tests remain
independent of the existing login. CI has no Qoder login configured, so its
replay fixture cannot establish the account-specific list-to-open round trip;
`--verify-open` checks that path explicitly with the operator's login.

This probe does not establish paid model availability, completion quality,
other accounts' catalogs, live Windows/macOS behavior or selection during a
concurrent catalog change. No model tokens were requested by the probe.
