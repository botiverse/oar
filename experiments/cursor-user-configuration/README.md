# Cursor SDK configuration sources

Run `pnpm tsx experiments/cursor-user-configuration/probe.ts` with the pinned
`@cursor/sdk` installed. The executable probe sets a temporary HOME before
loading the SDK, writes a synthetic SDK login, restricts TCP connections to
its local backend, and removes its files afterward. Run it as a separate
process because it observes native filesystem calls and sets process-wide
environment variables. No real account or model inference is used.

Observed on Linux, SDK 1.0.40, 2026-10-23:

| Open | User skill, hook and MCP files read | User MCP connects | Original stored login used |
|---|---|---|---|
| OAR default | no | no | yes |
| Native SDK `local.settingSources: ["user"]` positive control | yes | yes | yes |
| OAR `userConfiguration: "exclude"` | no | no | yes |
| Another OAR exclusion open after disposal | no | no | yes |

The SDK also reports one user rule and skill in the positive control. The
observer records actual native reads without changing their results.
Every open exchanges the synthetic stored key and reaches the local run
endpoint with the returned access token. That endpoint intentionally rejects
inference, and the probe asserts the terminal error. The login file remains
byte-for-byte unchanged and native `auth.status()` still reports logged in
after disposal and reopen. SDK keys are static; no refresh flow is claimed.

OAR passes `sandboxOptions.enabled: false`: native SDK code still reads the
user sandbox file, but the explicit option takes precedence. Default and
exclusion opens do not select project settings either. This evidence covers
local configuration selection, not successful model generation or
server-side account rules and memories. Managed organization policy remains
native.

The SDK's `CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON` is used only by this probe to
avoid an external model-catalog request. It is not an OAR option. The normal
SDK transport retry behavior is retained, so the four deliberate inference
errors can take about a minute.
