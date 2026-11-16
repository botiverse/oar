# Antigravity model-specific effort menus

Native agy 1.5.9 already supplies every model's effort combinations in
`session/new.models.availableModels`. The same IDs appear in `agy models`.
OAR previously read only `configOptions.thought_level`, which describes the
current model, so other models lacked their effort menus in host forms.

OAR now uses the same session/new response to associate each combination with a
unique canonical model prefix from `configOptions.model.options`. It keeps the
native suffixes as that model's effort menu, with no hardcoded list of levels.
The current model's own thought-level menu remains authoritative for that model.
Only its explicitly reported current effort is a default; other models get no
invented default. Ambiguous or unparseable IDs remain available as original native
selectors, with an `effortUnavailableReason`. They are not marked disabled.

## Native comparison

The [probe](native.ts) uses an isolated local provider and no real login. It reads
`agy models`, opens an ACP session, and compares the one-response projection with
each model's own menu after a temporary native switch. These switches are controls
in the experiment only. Product listing sends initialize, session/new, and close
when advertised; it sends no prompt or model-setting request.

[Selected evidence](selected.json), produced by [select.py](select.py), includes
all cited model menus, native version, timings and a fingerprint of each complete
local raw sample. Native 1.5.9 lists seven families: Hydrogen includes xhigh,
Carbon/Argon/Flash include medium, and Pro lists only low/high. All seven sets
match their individually selected thought-level menus. The 1.5.0 minimum-version
control lists five families and likewise matches all five menus.

On this Linux machine the one-shot OAR 1.5.9 listing took about 748 ms; the seven
individual model switches in the diagnostic control added seven ACP requests.
Their separate durations are retained in the selected results. Product request
count is unchanged, so the extra catalog information costs **zero additional
ACP requests**, not a fresh CLI catalog invocation. Both samples made zero model
provider requests. Timings are observations, not performance guarantees.

Persistent settings values were equal before and after listing. OAR neither
switches models nor writes settings. Native startup can rewrite JSON formatting:
the first diagnostic compared file bytes and incorrectly treated a difference as
configuration mutation. A second comparison using JSON.stringify was also sensitive
to key ordering. Both preparatory failures remain locally; the final probe compares
parsed values with deep equality, and per-phase parsed settings in the control
remained equal. The claim that switching changed persistent settings is withdrawn.

## Reproduce

```sh
pnpm tsx experiments/antigravity-model-menus/native.ts /path/to/agy-1.5.9 oar-trial-run/menus-159.json
pnpm tsx experiments/antigravity-model-menus/native.ts /path/to/agy-1.5.0 oar-trial-run/menus-150.json
python3 experiments/antigravity-model-menus/select.py oar-trial-run/menus-159.json oar-trial-run/menus-150.json
```

The native provider is synthetic, so this verifies the protocol mapping, not
which models an individual subscription permits. A future ambiguous prefix is
conservatively preserved rather than guessed. If the runtime exposes no effort
facility, all effort fields remain absent; an exposed but unavailable menu gets
the optional reason without borrowing levels from another model.

Unit controls cover distinct menus, missing menus, invalid defaults, absent
facilities, duplicate combinations, ambiguous prefixes, opaque selectors and the
exact request sequence. The native model-discovery vendor case checks both Flash
and Pro without a prompt on 1.5.9 and 1.5.0. Full repository checks cover the public
optional field and existing callers.
