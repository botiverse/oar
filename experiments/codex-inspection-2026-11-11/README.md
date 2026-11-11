# Codex inspection, 2026-11-11

The published OAR **0.97.0** package classified the tested native Codex
refusals correctly. It kept the session usable after refused input and
removed a known synthetic credential from public error surfaces. No new
product defect was confirmed.

This report supplies the public evidence for
[Codex's refusal boundaries](../../docs/runtimes/codex.md#refusals).
[results.json](results.json) selects the original results and native responses,
including the earlier observation that invalidated a probe assertion.
Paths and session/request identifiers are replaced with placeholders; full
stacks and process identifiers are omitted. Native refusal text and categories
are preserved. The credential strings shown are synthetic fixtures.

## Scope

- Linux x64, Node 24.19.0, real npm Codex **0.128.0, 0.132.0, 0.167.1**.
  Binary hashes are in `results.json`.
- Original run: npm `@botiverse/oar@0.97.0`, tarball SHA-1
  `8da8e6444e438fa5f139d95a9657cabf85dfd366`, importing its published Codex
  adapter and observation helpers. Dependencies resolved through an existing
  checkout, so this was not a clean-install test.
- Each version used isolated HOME, CODEX_HOME and workspace directories,
  a local scripted Responses provider, and a synthetic API key. Inherited
  credential environment entries were removed. No real login, model account,
  paid request or reset quota was used.
- Unknown-thread refusals use request injection: the wire forwarder changes
  the outgoing `turn/start` thread ID to a fixed absent UUID. The response
  comes from real Codex; it is not a fabricated refusal.
- Results do not establish native overload/draining behavior, queued steer,
  actual disappearance of an existing native thread, authenticated service-tier
  billing, or behavior on other platforms.

## Version, refusal and recovery matrix

The original completed matrix contains 32 cases: ten on each old version,
plus twelve on 0.167.1. The old damaged-config admission below was retained
separately from the earlier failed harness assertion.

| Case | 0.128.0 | 0.132.0 | 0.167.1 |
| --- | --- | --- | --- |
| `serviceTier: default` | `runtime_outdated`, `invalid_request` | opens | opens |
| `serviceTier: priority` | `runtime_outdated`, `invalid_request` | opens | custom provider reads back `default`; OAR refuses mismatch |
| `serviceTier: turbo` | plain native error | accepted and echoed; opens | custom provider reads back `default`; OAR refuses mismatch |
| Broken TOML on fresh open | `runtime_config_invalid`, `invalid_request` | same | same |
| Initial local turn | completes | completes | completes |
| 1,048,577-character input | `runtime_refused`, `input_too_large` | same | same |
| Absent thread ID injected into `turn/start` | `session_not_found`, no invented failure class | same | same |
| Valid local turn after refusals | completes | completes | completes |
| Broken TOML on resume | `runtime_config_invalid`, `invalid_request` | same | same |
| Resume effort `high` | `runtime_outdated`, requires 0.133.0 | same | opens |
| Break configuration after opening | separate admission observation below | not in matrix | `runtime_refused`, `invalid_request` |
| Remove provider configuration after opening | not in matrix | not in matrix | native `modelProviderMismatch`; `runtime_refused`, `invalid_request` |

The installation metadata deliberately claimed version `9.9.9`. Outdated
errors named the running 0.128.0 or 0.132.0 version from `initialize`.
Malformed-config errors retained the native file, line and column.

Every refused control in the completed matrix left the session idle and
appended a request/response pair, with no phantom turn. A valid prompt after
restoring configuration and removing the request fault completed.

### Earlier assumptions that failed

On **0.128.0**, after the session was open and `config.toml` was damaged,
the next prompt was **accepted**. The harness expected rejection and stopped
at that assertion, then disposed. That observation does not prove that the
version never reloads any configuration, nor that multiple later turns
complete. The portable reproducer explicitly checks that same admission-only
boundary and disposes without waiting for completion.

Two tier assumptions also failed: 0.132.0 accepted and echoed `turbo`, and
0.167.1 under the custom provider read `priority` back as `default`.
OAR's refusal of the latter mismatch was correct. The public script now
asserts each observed version's specific result. This is evidence about the
named strings and provider, not every arbitrary tier or billing policy.

The first credential fixture used an arbitrary `model_reasoning_effort`
string. 0.167.1 accepted it, so it did not provide a native diagnostic echo.
The final fixture uses `web_search` and verifies the actual echo count.
These failed assumptions were retained, not attributed to a product repair
or hidden behind a successful retry.

## Seven positive credential-echo cases

The probe sets an invalid `web_search` enum value equal to the supplied
synthetic `OPENAI_API_KEY`. Native errors echo that value on fresh open and
resume on all three versions, and on a post-open control on 0.167.1: **seven
native echoes**. OAR removes it from message, stack, cause, inspection text,
JSON serialization, and the control result/retained records while preserving
the error categories. Both the native errors and selected public errors are
in `results.json`.

The original focused `tests/codex/codex-refusals.test.ts` run passed all
15 tests. Overload/draining branches exercised only by those unit tests are
not presented as native observations.

## Reproduce

The committed scripts use the **current checkout's OAR source**, rather
than importing a machine-local extraction of 0.97.0. Record the checkout
commit when comparing a new run. They require Linux and Node 24; no native
probe runs in ordinary unit-test CI. Dependencies must already be installed
with `pnpm install`.

Supply the three Codex executable paths explicitly. For example, from the
repository root, install pinned npm packages into a new temporary directory:

```sh
probe_root=$(mktemp -d)
npm install --prefix "$probe_root/v128" --ignore-scripts --no-audit --no-fund @openai/codex@0.128.0
npm install --prefix "$probe_root/v132" --ignore-scripts --no-audit --no-fund @openai/codex@0.132.0
npm install --prefix "$probe_root/v167" --ignore-scripts --no-audit --no-fund @openai/codex@0.167.1
pnpm tsx experiments/codex-inspection-2026-11-11/refusal.mts \
  "$probe_root/v128/node_modules/.bin/codex" \
  "$probe_root/v132/node_modules/.bin/codex" \
  "$probe_root/v167/node_modules/.bin/codex" \
  "$probe_root/refusals"
pnpm tsx experiments/codex-inspection-2026-11-11/credential-echo.mts \
  "$probe_root/v128/node_modules/.bin/codex" \
  "$probe_root/v132/node_modules/.bin/codex" \
  "$probe_root/v167/node_modules/.bin/codex" \
  "$probe_root/credentials"
```

Each output directory must be new and is created with mode 0700. The scripts
check the version reported by native `initialize` against the expected slot;
installation metadata is not trusted. `refusal.mts` performs the original
32 cases plus the explicit old-config admission, and `credential-echo.mts`
performs the seven positive-echo cases.

Sessions, provider fixtures and temporary homes are closed in `finally`.
The scripts assert that their recorded wrapper/native processes have exited.
Raw `.wire.jsonl` logs remain in the private output directory for diagnosis;
they can contain machine-local paths, identifiers and native prompts. Do not
publish those raw logs. Selected JSON output replaces local roots and UUIDs;
review any new selection before publishing. After retaining the evidence you
need, remove only the temporary `probe_root` you created above.

The scripts preserve dynamic native/error fields for inspection and contain
file-level lint exceptions explaining that boundary. They remain included in
the repository's TypeScript and lint checks. `codex-wire.mjs` is an executable
stdio forwarder; `support.mts` contains argument, selection, version and
cleanup helpers.

## Repository reproducer check

The ported scripts were rerun on Linux x64 with the same three Codex
versions, against OAR source at base `8135d1ff` (0.98.0): 33 refusal/admission/
recovery cases and seven native credential echoes passed, with no recorded
owned process remaining. [reproduction-check.json](reproduction-check.json)
records that run separately from the original 0.97.0 evidence.
