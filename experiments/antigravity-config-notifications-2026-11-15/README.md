# Antigravity configuration notification confirmation

On 2026-11-15, a newly built synthetic agent reproduced an early refusal
when a config update with a previous value preceded the requested value.
The November 5 review reported this scenario, but its throwaway agent and
trace were not retained. This is a reconstruction, not that original
trace. No native runtime has been observed producing this particular
stale-before-correct sequence during OAR's serialized configuration.

## Evidence

- [Baseline synthetic trace](synthetic-baseline.json), OAR `6dfd108b`:
  `session/set_config_option` succeeds, a conflicting update arrives, and
  opening fails for both model and effort. The fake relay records the
  scheduled correct update, but OAR's cleanup stops it before delivery.
- [Updated synthetic trace](synthetic-fixed.json): the same relay delivers
  both notifications and the open succeeds with the requested model and
  effort. Both updates remain observable.
- [Native 1.5.9](native-1.5.9.json) and [1.5.0 control](native-1.5.0.json):
  three new sessions per version, each setting model and high effort,
  making one local-provider prompt, and trying an invalid effort value.
  All six prompts reached the scripted provider with `HIGH`; invalid
  values returned native JSON-RPC errors. Each version emitted six config
  notifications. Responses preceded notifications in these samples.

The native runs used Linux x64, isolated homes and a local scripted Gemini
provider. No real account or paid inference was used. Version 1.5.0 is a
focused control for the original observation, not a separate compatibility
commitment. The first invocation of the new probe used a relative binary
path with the fixture's working directory and failed before spawn with
ENOENT. It emitted no native frames; the probe now resolves its binary path
first. That preparation error is not a runtime failure.

The retained native messages include all fields of config notifications.
They identify the session and contain a complete option snapshot; they
have no request id, sequence, timestamp or correlation metadata. The RPC
response's id relates it to the request, but does not identify any
notification. These limited runs do not establish a universal absence of
vendor extensions. The [ACP config specification](https://agentclientprotocol.com/protocol/v1/session-config-options)
describes full configuration snapshots, without a required correlation
field or a response/notification ordering barrier. Antigravity's
[ACP documentation](https://antigravity.google/docs/cli/acp) does not add
such a contract.

## Confirmation rule and limits

The observer is attached before sending the setting. Within the existing
request deadline, OAR requires a successful RPC and a last observed value
for that session and option equal to the request. Earlier disagreement
keeps the same operation waiting; a later matching notification can finish
it. A match overwritten before the RPC response, or by another update in
the same notification batch, is not sufficient.

At the deadline, persistent disagreement becomes the existing refusal:
`ModelConfirmationError` with the final native string, or `reported: null`
for a non-string, for model; the existing plain refusal for effort. No
notification naming the option remains a timeout. Explicit RPC errors and
process exit keep their errors and fail immediately. There is no retry,
extra request, quiet period or deadline extension. The cost is that a
real disagreement now takes up to the 30-second config deadline to surface.

This is positive confirmation of an observed value, not causal attribution
of a notification. A later native change remains an ordinary recorded
observation. Neither a matching value nor an arbitrary quiet interval can
prove that another conflicting update will never arrive.

## Reproduce

From the repository root, after `pnpm install`:

```sh
pnpm tsx experiments/antigravity-config-notifications-2026-11-15/open.ts /tmp/agy-config-fixed
pnpm tsx experiments/antigravity-config-notifications-2026-11-15/native.ts /absolute/path/to/agy /tmp/agy-config-native.json
pnpm exec vitest run tests/acp/config-updates.test.ts tests/acp/acp-session-antigravity.test.ts
```

`open.ts` launches the repository fake agent through `fake-relay.mjs`.
The relay adds the conflicting notification and delays the correct one by
50 ms. To reproduce the baseline failure, run these experiment files
against OAR `6dfd108b`, passing `refused` as the last argument to `open.ts`.
The relay is used only for the synthetic control. `native.ts` launches the
unmodified vendor binary directly, observes wire fields and validates the
provider's actual thinking level. Public JSON replaces fixture paths and
synthetic session ids with labels; native config fields remain intact.

The deterministic tests cover recovering from a conflicting value,
persistent mismatch at the original deadline and its final reported value,
missing or unrelated notifications, matching-then-conflicting updates,
RPC refusal and process exit. The full open tests check errors through the
real process/SDK boundary. Existing missing-notification, RPC and exit
protections are expected to pass on the baseline too; they are preservation
controls, not evidence that the baseline was wrong in those cases.

## Validation

[Local results and exact native versions](validation.json), Linux x64:

- `CI=1 pnpm run check`: 4,281 tests and 18 mock behavior cases passed.
- Both focused test files: 38 tests passed, including real process exits
  before and after the RPC response.
- `sea-trial/all.ts`: all 15 backends passed. The separate Antigravity
  behavior run passed 17 cases.
- Native vendor regressions passed: Kimi 14, OpenCode 12, Grok 29 and
  Antigravity 14. These use isolated local providers, not account inference.
- Restoring the old confirmation implementation makes both new
  conflict-then-correct open cases fail. Deliberately classifying persistent
  disagreement as timeout, accepting without a notification, ignoring exit,
  or replacing the native RPC error are each caught by the targeted tests.
  All temporary mutations were restored before committing.

The dedicated 1.5.9 native probe also passed three more sessions after the
implementation change. Cross-platform PR CI remains a separate gate; these
local passes do not claim a Windows or macOS observation.
