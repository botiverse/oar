# Antigravity model-specific effort menus

With the isolated local Gemini provider used in #834, native agy 1.5.9 supplies
every model's effort combinations in `session/new.models.availableModels`. The
same IDs appear in `agy models` for that provider. This is not a guarantee for
signed-in Antigravity accounts: a reported 1.5.10 account catalog omits the
non-default combinations, leaving the current OAR projection incomplete there.
OAR previously read only `configOptions.thought_level`, which describes the
current model, so other models lacked their effort menus in host forms.

OAR now uses the same session/new response to associate each combination with a
unique canonical model prefix from `configOptions.model.options`. It keeps the
native suffixes as that model's effort menu, with no hardcoded list of levels.
The current model's own thought-level menu remains authoritative for that model.
Only its explicitly reported current effort is a default; other models get no
invented default. Ambiguous or unparseable IDs remain available as original native
selectors, with an `effortUnavailableReason`. They are not marked disabled.

## Synthetic-provider comparison (#834)

The [probe](native.ts) uses an isolated local provider and no real login. It reads
`agy models`, opens an ACP session, and compares the one-response projection with
each model's own menu after a temporary native switch. These switches are controls
in the experiment only. Product listing sends initialize, session/new, and close
when advertised; it sends no prompt or model-setting request.

[Selected evidence](selected.json), produced by [select.py](select.py), includes
all cited model menus, native version, timings and a fingerprint of each complete
local raw sample. With that synthetic provider, native 1.5.9 lists seven families: Hydrogen includes xhigh,
Carbon/Argon/Flash include medium, and Pro lists only low/high. All seven sets
match their individually selected thought-level menus. The 1.5.0 minimum-version
control lists five families and likewise matches all five menus.

On this Linux machine the one-shot OAR 1.5.9 listing took about 748 ms; the seven
individual model switches in the diagnostic control added seven ACP requests.
Their separate durations are retained in the selected results. Product request
count is unchanged, so the extra catalog information costs **zero additional
ACP requests**, not a fresh CLI catalog invocation. Both samples made zero model
provider requests. Timings are observations, not performance guarantees.

The measured `antigravity-cli/settings.json` values were equal before and after
listing in these two synthetic-provider samples. Other config files were not
measured by #834. OAR neither
switches models nor writes settings. Native startup can rewrite JSON formatting:
the first diagnostic compared file bytes and incorrectly treated a difference as
configuration mutation. A second comparison using JSON.stringify was also sensitive
to key ordering. Both preparatory failures remain locally; the final probe compares
parsed values with deep equality, and per-phase parsed settings in the control
remained equal. The claim that switching changed that file in those samples is withdrawn. This
does not establish absence of persistence for another provider or native version.

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

## Signed-in provider probe (#271)

[real-account.ts](real-account.ts) measures the reported gap without making a
model request. Run it only on the deliberately selected profile, using the exact
1.5.10 executable and workspace under investigation:

```sh
OAR_TEST=antigravity pnpm tsx experiments/antigravity-model-menus/real-account.ts /absolute/path/to/agy output.json /absolute/workspace
```

It opens one ACP session, records only the raw `availableModels` IDs and selected
model/configuration fields, then selects each canonical model and records its
returned `thought_level` options, current value and request duration. It sends no
`session/prompt`, exposes no filesystem/terminal capability, and drops native
notifications and reverse requests. Native initialization can still access the
network and write configuration. The process uses the same ACP arguments as OAR
listing, including the explicit profile directory when `GEMINI_HOME` is set.

The probe compares parsed values in these locations before startup, after opening,
after every model selection, after restoration and after exit:

- Under the selected Gemini directory: `antigravity-cli/settings.json`, legacy
  `antigravity-acp/settings.json`, `config/config.json`, `config/mcp_config.json`,
  and `settings.json`.
- Under the selected workspace: `.gemini/settings.json`.

Each phase compares with the initial snapshot. `changesSincePrevious` lists only
changed or uncomparable files since the preceding phase, to distinguish startup
writes from selection writes. `equal: null` means unreadable or invalid JSON,
not evidence of equality. This is a bounded list of known files, not a claim
about every native side effect. File values remain in memory: output includes
only menu values under known menu keys; all other values and object keys are
redacted, without account fingerprints. Native diagnostics, session IDs and
absolute paths are not emitted. Inspect the resulting report before sharing it.

It refuses to switch when the initial model or an exposed effort selection is
unknown. In `finally`, the script selects the initial model and effort through ACP and
checks native readback, even after a failed switch. It never rewrites settings or
credentials itself. A failed restoration is explicit and causes a nonzero exit;
process termination outside that cleanup path cannot guarantee restoration.
Successful session restoration alone does not prove unchanged persistent values:
inspect the final parsed comparisons too. Saved defaults must either stay equal
or be exactly restorable before enabling per-model switching in product listing.

A Linux 1.5.10 control with an isolated Gemini provider validated this probe:
seven model selections, two restoration requests, initialize/new/close (12 ACP
requests total), zero provider requests, and confirmed model/effort restoration.
The expanded file check also observed startup creating `config/config.json` and
an unparseable `config/mcp_config.json`. The parsed config file did not change during model
selection; the unparseable file remains unknown. This distinguishes measured
startup writes from selection effects without treating unknown data as equal. Its measured
selection/restoration cost is recorded in [local-control.json](local-control.json).
This control is not the signed-in measurement. The armbian signed-in result is
still required; no production switching behavior is introduced by this probe.

Reproduce the isolated control, without selecting the machine's account:

```sh
pnpm tsx experiments/antigravity-model-menus/local-control.ts /absolute/path/to/agy experiments/antigravity-model-menus/local-control.json
```

Regression controls cover distinct menus, refusal before switching when the
initial effort is unknown, restoration on success and switch
failure, rejected restoration readback, parsed equality independent of key order,
invalid JSON, and redaction of account data.
