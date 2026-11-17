# Antigravity model-specific effort menus

With the isolated local Gemini provider used in #834, native agy 1.5.9 supplies
every model's effort combinations in `session/new.models.availableModels`. The
same IDs appear in `agy models` for that provider. This is not a guarantee for
signed-in Antigravity accounts: the signed-in 1.5.10 result below has a different catalog and must be read
through its own selected menus.
OAR previously read only `configOptions.thought_level`, which describes the
current model, so other models lacked their effort menus in host forms.

The #834 implementation used the same session/new response to associate each combination with a
unique canonical model prefix from `configOptions.model.options`. It kept the
native suffixes as that model's effort menu, with no hardcoded list of levels.
The current model's own thought-level menu remains authoritative for that model.
Only its explicitly reported current effort is a default; other models get no
invented default. Ambiguous or unparseable IDs remain available as original native
selectors, with an `effortUnavailableReason`. They are not marked disabled.

## Synthetic-provider comparison (#834)

The [probe](native.ts) uses an isolated local provider and no real login. It reads
`agy models`, opens an ACP session, and compares the one-response projection with
each model's own menu after a temporary native switch. In #834 these switches were diagnostic controls only; that product revision
sent initialize, session/new and close. The current implementation below also
switches models within that same temporary session.

[Selected evidence](selected.json), produced by [select.py](select.py), includes
all cited model menus, native version, timings and a fingerprint of each complete
local raw sample. With that synthetic provider, native 1.5.9 lists seven families: Hydrogen includes xhigh,
Carbon/Argon/Flash include medium, and Pro lists only low/high. All seven sets
match their individually selected thought-level menus. The 1.5.0 minimum-version
control lists five families and likewise matches all five menus.

On this Linux machine the one-shot OAR 1.5.9 listing took about 748 ms; the seven
individual model switches in the diagnostic control added seven ACP requests.
Their separate durations are retained in the selected results. For the historical #834 implementation the request
count was unchanged, so the catalog information cost **zero additional
ACP requests**, not a fresh CLI catalog invocation. Both samples made zero model
provider requests. Timings are observations, not performance guarantees.

The measured `antigravity-cli/settings.json` values were equal before and after
listing in these two synthetic-provider samples. Other config files were not
measured by #834. That product implementation did not switch models or write settings. Native startup can rewrite JSON formatting:
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

It runs two separate native processes in order against the same profile and workspace:
first initialize/new/close with no selection requests, then initialize/new followed
by every canonical model selection and restoration/close. Each run records only
raw `availableModels` IDs and selected model/configuration fields. The second run
records each returned `thought_level` menu, current value and request duration.
A failed baseline or failed close prevents the second run. It sends no
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

For each run, `fileInventory` scans every file beneath the selected profile root and
workspace `.gemini/` before startup and after exit. It lists created, removed,
size-changed or mtime-changed entries, with relative paths, sizes and mtimes only;
no file contents are read by this inventory. Email-, UUID- and long hex-shaped
filename components become `[redacted-name]`. Nested symlink targets are not
traversed. Scan errors and unscanned links set `complete: false`, so an incomplete
scan cannot establish absence of writes. Changes outside these roots, or writes
that preserve both size and mtime, are outside this metadata comparison.

`difference` compares the two runs' changed paths, retaining the metadata for
baseline-only, switch-run-only and shared changes. It groups already-redacted
UUID filenames and native timestamp/PID log names; each run retains its separate
entries. It also checks whether both sessions began with equal selection and
catalog fields. These are observations, not a causal proof: the second run starts
with a warmed profile, and two new sessions create different session files.
A protobuf or settings file changed only in the switch run needs investigation;
a file changed in both can also contain extra switch state. Metadata alone cannot
establish its contents or prove restoration. Native readback and parsed settings
comparisons remain separate evidence.

Each phase compares with that run's initial snapshot. `changesSincePrevious` lists only
changed or uncomparable files since the preceding phase, to distinguish startup
writes from selection writes. `equal: null` means unreadable or invalid JSON,
not evidence of equality. This is a bounded list of known files, not a claim
about every native side effect. File values remain in memory: output includes
only menu values under known menu keys; all other values and object keys are
redacted, without account fingerprints. Native diagnostics, session IDs and
absolute paths are not emitted. Inspect the resulting report before sharing it.

After that pair, `persistence` tests defaults through behavior. A third process
selects the last listed model different from the original, leaves it selected and
closes. A fourth process opens a fresh session and reads its initial model and
effort. Matching the original is reported as `default_unchanged`; matching the
selected model is `selected_model_persisted`; another difference is
`other_default_change`. An unknown or failed observation is `inconclusive`.
If fresh defaults differ or cannot be observed, the probe opens another process
to restore the original model and effort through ACP, closes, and verifies both
with one more fresh process. It reports restoration separately from persistence.
A changed default is still reported even when restoration succeeds. No alternative
model means this behavioral control is inconclusive. Avoid concurrent use of the
selected profile during the measurement.

The initial paired switch run retains restoration before close. It refuses to
switch when the initial model or an exposed effort selection is unknown. In `finally`, the script selects the initial model and effort through ACP and
checks native readback, even after a failed switch. The deliberate leave-selected
control skips this cleanup only after a successful switch; its enclosing control
performs the fresh-process observation and any required restoration. It never rewrites settings or
credentials itself. A failed restoration or inconclusive behavioral result causes a nonzero exit;
process termination outside that cleanup path cannot guarantee restoration.
Successful session restoration alone does not prove unchanged persistent values:
inspect the final parsed comparisons too. Saved defaults must either stay equal
or be exactly restorable before enabling per-model switching in product listing.

A Linux 1.5.10 control with an isolated Gemini provider validated the pair:
the baseline used three ACP requests; the second run used seven model selections,
two restoration requests and initialize/new/close (12 requests). The behavioral
control added four requests to leave another model selected and three to read a
fresh session. The fresh default was the original `gemini-3.1-pro` with `low`
effort, so no further restoration was needed. All four sessions together used
22 ACP requests and zero provider requests, plus four version queries; the
restore-before-close path also confirmed model/effort restoration.
Both runs wrote conversation state, summaries and logs. The baseline also created
bundled assets and configuration files in the fresh profile. No additional path
category was observed only in the switch run after grouping per-process log names;
this is not proof of unchanged protobuf contents. Parsed settings/config remained
equal during selection; an unparseable MCP file remains unknown. The selected
[control evidence](local-control.json) retains the per-run changes and timings.
This is the synthetic control. The separately measured signed-in result follows.

Reproduce the isolated control, without selecting the machine's account:

```sh
pnpm tsx experiments/antigravity-model-menus/local-control.ts /absolute/path/to/agy experiments/antigravity-model-menus/local-control.json
```

Regression controls cover the baseline-first request sequence, refusal to continue
a failed baseline, extra file writes, volatile and persisted defaults, verified
restoration in a fresh process, failed restoration, distinct menus, refusal before switching when the
initial effort is unknown, restoration on success and switch
failure, rejected restoration readback, parsed equality independent of key order,
invalid JSON, metadata-only file changes and incomplete scans, and redaction of
account data and malformed native diagnostics.

## Signed-in result and product readback

[Account evidence](account-1.5.10.json) was produced on Linux arm64 with agy
1.5.10 and probe commit a58c7e77. It records zero prompt requests, successful
restoration of Flash/high before close, and `persistence.status: default_unchanged`
after leaving GPT-OSS selected and opening a fresh process. It does not prove
that no files were written: conversation state, summaries and logs changed in
both paired runs. The inventory is incomplete because a symlink was not traversed;
invalid MCP JSON also remains unknown. No path category occurred only in the
switch run, which is not proof of identical protobuf contents.

| Selected canonical model | Native thought-level menu |
| --- | --- |
| gemini-3.8-flash | low, medium, high; original current value high |
| claude-sonnet-4-6 | absent |
| claude-opus-4-6-thinking | absent |
| gpt-oss-120b-medium | absent |

The four selections took 4.40, 1.48, 1.63 and 8.53 ms respectively. Model and
effort restoration took another 24.64 and 14.33 ms. These are one account's
observations, not latency guarantees. It listed no non-default Gemini model:
Hydrogen's signed-in menu remains unverified, while its synthetic control is
recorded above.

Product listing now selects every canonical model on the existing temporary
session and projects only that model's confirmed returned menu. It preserves an
absent selector as no effort, clears stale catalog-derived fields on failed or
unconfirmed switches, and reports the read gap on that model. It assigns a default
effort only to the original current model, from its initial explicit value. It
restores and confirms the original model and effort before close, rejecting the
entire listing if restoration cannot be confirmed. No model prompt is sent.

The normal product cost is initialize/new/close, N selection requests, and one
model restoration plus one effort restoration when effort was initially exposed.
Thus the four-model account uses nine ACP requests in one conversation, not the
four sessions used by the diagnostic persistence probe. When initial state is not
restorable, or the first selection is natively unsupported (method-not-found),
the original catalog is the fallback. An individual failed switch does not invoke
that fallback. Unit controls cover these boundaries and cleanup after failure.

The product readback control passes on native 1.5.10 and minimum 1.5.0: Flash
and Pro keep their distinct menus, a fresh session retains the original default,
and the provider receives no requests. The 1.5.10 ACP vendor suite passes three
cases; its shared behavior suite passes 18 with two capability skips.
