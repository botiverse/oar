# Codex idle model catalog refresh

Codex **0.169.0** starts a model-catalog worker with a hard-coded
**270-second** delay after each completed refresh. No public stop or interval
setting for that worker was found. `model_catalog_json` replaces the remote
manager with a static one, avoiding its catalog HTTP requests, but transfers
catalog freshness to the host. OAR does **not** enable it by default.

Checked on Linux x64, 2026-11-16, with the official Codex binary, isolated
homes, synthetic credentials and a loopback catalog server. No turn or
inference was submitted. This is not a measurement of ChatGPT response bytes,
real account entitlement, process memory, or the benefit of sharing an
app-server. Those claims require separate evidence.

## Native observations

[probe.ts](probe.ts) asserts the cases below. [native.json](native.json)
contains the selected results; every model name and provider credential in
the experiment is synthetic. HTTP observations retain only a fixed scenario
label, path and monotonic elapsed time, not headers or arbitrary queries.

| Case | Observed result |
| --- | --- |
| Dynamic local catalog | Initial picker returns `probe-remote-a`. Changing the server response does not immediately change that picker. After the native refresh period, it returns `probe-remote-b`. |
| Idle HTTP | One initial dynamic catalog request and another approximately 270 seconds later, while no thread or turn is running in that app-server. |
| Static catalog | Startup picker returns `probe-fixed-a`, makes no catalog HTTP request, and still returns A after changing the file to B and crossing the same idle interval. The server attributes all catalog requests to the dynamic scenario. |
| Fresh OAR query | `codexListModels` with the same `CODEX_HOME` starts a new process and returns B after the file edit. It projects the native default and effort menu; it does not reconcile the old process. |
| OAR session from config file | A new `codexSession` using the same home opens with B as the native default, without an inference or catalog request. |
| OAR session from launch arguments | A separate home without a catalog setting opens with A when `launchArgs` supplies `-c model_catalog_json=...`. It makes no catalog request. |
| API-key discovery disabled | The custom provider returns an empty picker and makes no catalog request. This gate is specific to API-key discovery, not a general ChatGPT refresh switch. |

The initial observation used a single catalog URL. The final probe adds
per-scenario attribution and the two OAR session entry controls. Both complete
idle observations are retained locally. The committed result is the final
probe's output, not a synthesized transcript.

## Source basis, pinned to 0.169.0

Official source tag `rust-v0.169.0` resolves to
`d32063f96c2dff1dc96af839b3952abb6acfeda4`.
[validation.json](validation.json) records the downloaded archive, source and
local validation fingerprints.

1. [`models_refresh_worker.rs`](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server/src/models_refresh_worker.rs)
   defines `MODELS_REFRESH_INTERVAL` as `4 * 60 + 30` and production `spawn`
   always uses it. The loop requests `RefreshStrategy::Online`, then sleeps;
   it stops on shutdown/drop. The parameterized helper is private. The
   [`message processor`](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server/src/message_processor.rs)
   starts the worker. No config or environment interval is read on this path.
2. [`models-manager/src/manager.rs`](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/models-manager/src/manager.rs)
   has a 300-second disk cache TTL, but `Online` does not use that TTL to
   suppress the request. `api_key_discovery_disabled` applies to API-key
   auth; it is not a control for ChatGPT catalog polling. A
   `StaticModelsManager` ignores the refresh strategy and clones its loaded
   entries, making no catalog HTTP request.
3. [`model-provider/src/provider.rs`](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/model-provider/src/provider.rs)
   constructs that static manager when `config_model_catalog` exists.
   [`ConfigToml`](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/config/src/config_toml.rs)
   explicitly describes `model_catalog_json` as startup-only and per-thread
   overrides as accepted no-ops. The
   [official configuration reference](https://developers.openai.com/codex/config-reference/)
   also describes it as a startup catalog path. It is a complete native
   `ModelsResponse`, not the different `model/list` picker response.
4. [`model_catalog.rs`](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server/src/model_catalog.rs)
   retains the loaded config/manager. An ordinary file edit does not
   invalidate it. Explicit native catalog invalidation can reload config,
   so this evidence does not claim that a restart is the only possible
   refresh or that the static manager survives all account changes.
   The background refresh also visits retained originator catalogs; one
   app-server does not universally imply exactly one HTTP request per cycle.
5. Native [`catalog_processor.rs`](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server/src/request_processors/catalog_processor.rs)
   uses `OnlineIfUncached` for `model/list`. OAR's
   [`codexListModels`](../../packages/oar/src/runtimes/codex/list-models.ts)
   starts a fresh app-server, paginates that picker, reads config for the
   requested cwd, and disposes the process. It is a new configuration
   snapshot, not a query of an already open OAR session.

The native `model_providers.<id>.auth.refresh_interval_ms` setting refreshes
command-based credentials. It does not set this catalog worker's interval.

## Host choice and existing OAR entry points

No adapter change is needed. The [runtime page](../../docs/runtimes/codex.md#idle-model-catalog-refresh)
documents both tested entries:

- Put the top-level `model_catalog_json` in an explicit
  `CODEX_HOME/config.toml`, and give the same absolute `CODEX_HOME` to session
  and model-listing environment overlays. This reaches both processes.
- For a session alone, pass `launchArgs: ["-c",
  'model_catalog_json="/absolute/path/catalog.json"']`. OAR passes these
  arguments to the app-server before startup. They are not per-thread config.
  `ListModelsOptions` has no `launchArgs`, so this session-only choice does
  not configure a subsequent model-listing call.

The host now owns the catalog's IDs, defaults, reasoning and tool metadata,
context limits and model instructions, as well as when those facts change.
A static file can become stale relative to the provider or the active
account, and listing a model is not an authorization to run it. An existing
process and a fresh query can disagree after a file edit, as observed above.
Use a deliberate host update/reopen policy if choosing this option; OAR
neither silently pins the catalog nor invents a cache invalidation protocol.

OAR's default stays native dynamic discovery. Reducing the number of
app-servers, with the separately required sharing and credential-isolation
evidence, addresses duplicate workers without changing model freshness.
An upstream configurable interval or backoff would be a different native
solution; none is established here for 0.169.0.

## Reproduce and validation limits

Install `@openai/codex@0.169.0` in a temporary prefix, then from the repository:

```sh
OAR_CODEX_BIN=/absolute/path/to/codex \
OAR_CATALOG_PROBE_OUTPUT=/absolute/path/to/results.json \
  pnpm tsx experiments/codex-model-catalog-refresh/probe.ts
```

The script verifies the native initialize version, starts only a loopback
server, replaces the child environment, creates isolated homes and removes
them in `finally`. It waits 276 seconds for the native 270-second cycle;
a watchdog bounds raw-client lifetime. It rejects any loopback path except
the catalog endpoint and asserts that only the dynamic scenario requested it.
It is a manual experiment, not a new CI delay or production timeout.

The first scratch fixture omitted the native-required `base_instructions`
field. Its initial picker fell back to defaults; a follow-up `config/read`
identified the malformed catalog. Those two preparation failures are kept
locally with fingerprints rather than being presented as successful runs.
The fixture was corrected before the two passing idle observations. The
native warning about refusing PATH helper creation under a temporary home
was retained and did not prevent these catalog-only controls.

The commit gate and exact result fingerprints are in
[validation.json](validation.json). No production source, dependency, or CI
workflow changes are part of this report.
