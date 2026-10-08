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
