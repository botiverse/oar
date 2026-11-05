# Qoder DeepSeek custom-model probe

Qoder 1.1.83 supports the tested DeepSeek BYOK path. Bugen ran the attached
probe on Linux x64 with an existing Qoder Free login and a DeepSeek pay-as-you-go
API key: inference, native Read/Write tools and cross-process resume passed.
Three user submissions were made, and the temporary model configuration was
removed. This verifies that credential path, not Qoder first-party models or
subscription quota.

The [official custom-model instructions](https://docs.qoder.com/cli/custom-models)
use `/model` > Custom > Add custom model. The current provider catalog is
its source of truth; the instructions explicitly discourage configuring BYOK
by editing `settings.json`. The probe uses the same native daemon's BYOK
controls and does not construct an alternative provider connection.

## Read-only observation on 2026-11-05

- Package: `@qoder-ai/qodercli@1.1.83`, npm `latest` at inspection time.
- OAR source for the prepared execution probe: `4fd225c8`.
- Native `daemon.get_byok_config` contains provider `deepseek`, group `pg`
  (Pay As You Go), and `deepseek-flash-pg` / `deepseek-v4-pro-pg`.
  Both use native format `openai`; the required credential field is `api_key`.
- `daemon.check_byok_config` with the catalog provider/model and empty
  parameters returns `BYOK_CONFIG_INVALID`, `parameters must not be empty`.
  In the inspected bundle, this check runs **after** the account-access guard
  and **before** any provider credential validation. This establishes that
  the selected account passed that guard, not that a real key or inference
  request will succeed. The native bundle hashes are in
  [source-hashes.json](source-hashes.json).
- The daemon exits normally after EOF. No configuration was created or
  deleted. Native catalog/auth caches may still be refreshed by these reads.
- No Qoder subscription was purchased. This evidence does not establish
  first-party subscription behavior, another account's entitlement, or
  compatibility of arbitrary OpenAI-compatible endpoints.

[readonly.json](readonly.json) contains the selected native facts. The probe
retains no account identifier, email, credential, credential fingerprint or
local path. The source locations for the access-check inference are
`daemonCheckByokConfig`, `byokConfigManager.check`,
`requireByokConfigAccess` and `HNr` in the published worker bundle.

## Repeat the read-only check

Use a native 1.1.83 installation and an existing Qoder login. From the OAR
checkout:

```sh
QODER_PROBE_COMMAND=/path/to/qodercli pnpm exec tsx experiments/qoder-deepseek/probe.ts
```

The script deliberately checks the reviewed native version before relying
on the empty-parameters check's ordering. The read-only run and a missing
executable failure were exercised; the latter exits with `SPAWN_FAILED`
without hanging. The script passes repository typechecking and lint, and the OAR package builds.

## Reported real-flow result on 2026-11-05

Bugen executed the probe against OAR `4fd225c8`, Qoder 1.1.83, Linux x64,
using an existing Free-account login and the catalog's DeepSeek-Flash
pay-as-you-go model. Native credential validation returned success. The
three checks passed: a fresh response, two Read/Write tool lifecycles with an
exact resulting-file check, and recovery of the conversation marker after
opening the saved session in a new native process.

| Native usage | Input tokens | Output tokens | Cache-read tokens |
| --- | ---: | ---: | ---: |
| First process, two submissions | 128104 | 254 | 54272 |
| Resumed process, one submission | 37275 | 24 | 18560 |

The temporary BYOK configuration was created and deleted. The source is
Bugen's result in Raft, November 5 at 12:26 UTC, message
`028d76a4-44c5-46c9-a148-5a8b5ac2f187`, followed by public attachment
`19dd8957-c701-4015-a38f-484d3c3612a1` in message
`4fc575b1-9f20-40f7-ade4-70f7f0082cd2`. Its unchanged
[selected JSON](execution.json) confirms three native `result` / `success`
summaries with `isError: false`, the reported usage and successful cleanup.
This is Bugen's execution evidence, not an independent rerun or an inspection
of raw provider traffic. No credential or local account path is included here.

An earlier read-only run using a different home had no login and no DeepSeek
catalog entry. It submitted zero prompts and created no model configuration.
Reusing the already logged-in Free environment passed that prerequisite;
no new login or paid Qoder subscription was needed.

This is execution evidence for these three flows on 1.1.83. It does not
restore native replay, replace the full CI suite pinned to 1.1.81, establish
cancellation behavior, or verify first-party model access, rate limits and
quota. The key remained on Bugen's machine.

## Repeat the real-flow probe

After `DEEPSEEK_API_KEY` has been injected privately into the process:

```sh
pnpm --filter @botiverse/oar build
QODER_PROBE_COMMAND=/path/to/qodercli pnpm exec tsx experiments/qoder-deepseek/probe.ts --run
```

This performs native credential validation, creates one uniquely named
native DeepSeek-Flash configuration, and makes at most three user submissions:

1. Confirm a fresh text response and remember a random conversation marker.
2. Read a temporary file and copy its exact contents using native file tools;
   check the actual resulting file and tool lifecycle records.
3. Dispose the original native process, resume the same session through OAR,
   and recover the conversation marker without tools.

Each prompt has a 90-second abort boundary and a 105-second session-release
fallback. There is no automatic prompt retry. The result contains selected
native completion facts, tool names and token totals, not full frames. The
script removes its own native configuration and temporary files in cleanup
and reports any cleanup failure. It neither replaces existing configurations
nor leaves the API key in the Qoder child environment. Native BYOK storage
handles the temporary credential; no credential is written by this script
into a report or command-line argument.

Credential validation itself may contact the provider. The successful result
demonstrates this third-party API-key path only, not Qoder's own paid
model catalog, quota, rate limits or subscription login behavior. The probe
is manual evidence and is not part of CI.
