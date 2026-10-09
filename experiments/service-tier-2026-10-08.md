# Session service tiers: 2026-10-08

Issue [249](https://github.com/botiverse/oar/issues/249) gives hosts a native
speed-tier selector without silently changing their choice. Discovery owns
the per-model menu, session opening applies and checks the option, and record
projections expose the runtime's answer. The host owns labels and the choice
between cost and latency. There is no per-turn setter or global settings write.

## Native evidence

Codex 0.161.0's generated app-server types expose `serviceTier` on
`ThreadStartParams`, `ThreadResumeParams`, their replies and `ThreadSettings`.
`Model.serviceTiers` contains `{id, name, description}` entries;
`defaultServiceTier` is nullable. The current native picker reported the ID
`priority`, labelled Fast. Deprecated `additionalSpeedTiers` is not used.
Passing the alias `fast` reports `priority`, so OAR refuses the mismatch.

The real Codex executable against a local scripted Responses provider:

| Open | Native report | Provider `service_tier` |
|---|---|---|
| New, priority | priority | priority |
| Resume, omitted, config without a tier | null | absent |
| Resume, flex | flex | flex |
| Resume, omitted, config priority | priority | priority |
| Resume, default, config priority | default | absent |

Omission on resume re-reads configuration, not the previous turn's tier.
The resume that changes effort also preserves its explicitly requested tier.
`default` is an explicit opt-out, accepted outside the native catalog and
never added to `ModelEntry.serviceTiers`. A null native report is projected
as default; a missing field cannot confirm any explicit request.

Claude 2.1.293 accepts `--settings '{"fastMode":true}'` in stream-json print
mode and reports applied `fast_mode_state` through `initialize`, before a
prompt. `get_settings.effective.fastMode` only shows configuration intent;
its applied block has no fast status. `list_models.supportsFastMode` is the
capability fact used for the fast menu. Unsupported models report off even
with the flag enabled and are refused before a model call.

A fresh Claude configuration directory with a local scripted Messages
provider confirms fast on new and resumed sessions sends `speed: "fast"`;
default on resume removes it. Initialization off/cooldown, an absent report,
a rejected control or a readback timeout cannot confirm requested fast.
Later native on/off/cooldown reports remain observable in `service_tier`
events, `Session.serviceTier()` and `SessionView.serviceTier`.
Combined effort and fast mode are confirmed separately at open and both
reach the Messages request.

The other six core adapters explicitly refuse the option until a native
per-session setting and readback are verified. No service tiers are invented
for them.

## Model catalog comparison, 2026-10-09

The lister changes from `debug models` to app-server `model/list`, so this
comparison checks the host-visible IDs as well as the added tier metadata.
Both commands used Codex 0.161.0 and the same configuration in each case.

| Environment | Native account present | OAR result | Former visible IDs | New picker IDs | ID differences |
|---|---|---|---|---|---|
| Existing authorized xxwork login | yes | `ok` | 7 | 7 | none, including order |
| Fresh empty `CODEX_HOME`, empty working directory, no API key | no | `ok` | 8 | 8 | none; order differs |

The authenticated set was `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`,
`gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. Each picker
entry supplied `priority`. The logged-out fallback also included `gpt-5.5`;
`debug models` placed `gpt-6-astra` first, while the picker placed
`gpt-6.1-sol` first. These are dated observations, not a static model allowlist.

The empty home had no configuration, credentials or model cache at launch.
OAR's public `codexListModels` ran first, before `debug models` could seed a
cache. A separate `account/read` reported null. The new lister therefore still
returns a built-in fallback without authentication, not `unauthenticated`;
hosts must not interpret a successful list as proof of model access. Native
startup/RPC failures and malformed replies still throw.

[codex-list-models.ts](codex-list-models.ts) reproduces the comparison and
prints only model metadata and login presence. Set `OAR_CODEX_BIN` to the
executable to compare. Run once under the existing configuration, then in an
empty working directory with `CODEX_HOME` pointing at a new empty directory
and authentication environment variables such as `OPENAI_API_KEY` and
`CODEX_API_KEY` removed. No model prompts were submitted. The result is scoped
to this runtime version and these environments; other providers and later
versions may produce different IDs.

## Reproduction and limits

The reusable regression is
[service-tier.vendor.test.ts](../sea-trial/vendor/service-tier.vendor.test.ts):

```sh
OAR_TEST=codex-aimock pnpm exec vitest run sea-trial/vendor/service-tier.vendor.test.ts
OAR_TEST=claude-aimock pnpm exec vitest run sea-trial/vendor/service-tier.vendor.test.ts
```

Set `OAR_CODEX_BIN` or `OAR_CLAUDE_BIN` to the executable being checked.
These tests use real binaries and local scripted model providers. Initial
catalog and settings inspection used existing authorized xxwork logins,
without model prompts. No real model tokens were consumed. This verifies
native selection, readback and outgoing request fields, not provider billing,
speed guarantees or future capacity. Those may change after a successful open.
