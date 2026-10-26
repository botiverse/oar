# Orientation cost probes

Build the CLI and run the local/account controls with real installed binaries:

```sh
pnpm run build
OAR_CLAUDE_BIN=/path/to/claude OAR_CODEX_BIN=/path/to/codex \
  OAR_QODER_BIN=/path/to/qodercli pnpm tsx experiments/orientation/local.ts
```

The script creates synthetic credential stores under a temporary HOME and
routes HTTP(S) through a local proxy that rejects every request. No real
account, model turn or login is used. A key-command sentinel records execution.
The built CLI's JSON is checked for synthetic secrets. `OAR_QODER_BIN` is
optional; Claude and Codex are required. Cursor has a separate credential-source
control below.

Linux observations on October 24, 2026 used Claude 2.1.309, Codex 0.164.0,
Cursor SDK 1.0.40 and Qoder 1.1.78. Pi uses the repository's pinned SDK.

| Control | Observation |
| --- | --- |
| Codex stored API key, local (original October 24 implementation) | Native `login status` reported a configured key without network access. This covered only that source; the declaration was withdrawn after review, as described below. |
| Pi expired OAuth and stored key command, local | Metadata remains visible; no refresh, key-command execution or credential-file rewrite. |
| Claude expired OAuth, local | Auth is skipped by depth; no refresh. |
| Claude expired OAuth, account | Native auth/usage queries attempt connections to the OAuth/API hosts. The proxy refuses them, retaining evidence of the cost. |
| Claude apiKeyHelper, local | Auth is skipped and the helper is not executed. |
| Claude apiKeyHelper, native auth status only | This status command does not execute the helper in the tested version. |
| Claude apiKeyHelper, account | The subsequent account-usage query executes the helper. |
| Cursor stored user key and expired key, local | Native SDK status reports logged-in and logged-out respectively; neither contacts the network. |
| Qoder, local | Installation discovery runs; the unproven auth reader is skipped. |

An initial version called Claude auth status at local depth and failed the
network assertion. That evidence caused the reader declaration and depth skip;
no parser for native credential files was added. A later control separated
auth-status-only from the full account depth after the latter executed the
helper. Native account operations can mutate credential stores, so hosts must
choose them deliberately.

## Codex source boundary

The original stored-API-key control did not establish that every native status
path was local. Codex 0.164.0's personal access token loader hydrates metadata
over HTTP; agent and workload identity paths also resolve remotely. OAR now
skips Codex auth at local depth for every credential source, without inspecting
its auth files. `local.ts` checks that both a stored API key and an environment
personal access token are skipped, then calls native `login status` directly
with the synthetic personal token and a rejecting local auth endpoint. Its
`/v1/user-auth-credential/whoami` request is the positive network control.
The October 26 Linux run observed that request with Codex 0.164.0; all local
snapshots made zero connections. The first control failed because its synthetic
token omitted the native `at-` prefix and was parsed as an invalid identity JWT.
Correcting the fixture selected the personal-token path without changing the
assertion. The same run repeated the other CLI controls with Claude 2.1.310
and Qoder 1.1.78.
The original failed unit regression and subsequent passing check establish
that the local snapshot does not start the status command; account depth does.

Both `login status` and app-server initialization pass
`enable_codex_api_key_env: false` in this version. `CODEX_API_KEY` alone does
not select another account for OAR's app-server session. Custom providers can
separately name an `env_key`; this observation does not override their settings.
See the [runtime source links](../../docs/runtimes/codex.md#orientation-query-costs).

## Cursor status credential sources

Run `pnpm tsx experiments/orientation/cursor-status.ts`. It starts a fresh
process with an isolated HOME, imports the actual SDK only after installing
socket/fetch guards, and compares native status with OAR's local snapshot.
Every file is synthetic, status leaves it unchanged, and no login or model
request runs. Linux, SDK 1.0.40, October 26, 2026:

| Source/control | Native status | OAR auth |
| --- | --- | --- |
| Missing, malformed or foreign-shaped file | logged-out | logged_out |
| Stored unexpired or non-expiring user key | logged-in | logged_in, stored identity only |
| Stored expired key | logged-out | logged_out |
| Environment key without a stored login | logged-out | unknown, no account identity |
| Environment key with a valid or expired stored login | The stored login's status | unknown, no account identity |
| Empty environment key with a stored login | logged-in | unknown; the SDK's nullish precedence still selects the variable |
| Backend override different from the stored key's backend | logged-in | Stored-login metadata; not remote key validation |
| Explicit native in-memory store | Its unexpired/expired status | Not an OAR status option |
| Native custom store whose load calls fetch | Network guard rejects it | Not an OAR status option |

All normal controls made zero network attempts. The custom-store positive
control made exactly one blocked fetch. The SDK bundle audit covered the
operation error wrapper, `Cursor.auth.status`, `FileCredentialStore.load` and
`parseStoredSdkCredentials`; none invokes the separate
`resolveDefaultApiKey` used for model requests. That resolver accepts an
explicit `apiKey`, then `CURSOR_API_KEY`, then a backend-paired stored key.
Status accepts only an optional store, which OAR never supplies. Arbitrary
custom stores are not covered by OAR's declaration. The relevant package
declarations are `auth/login.d.ts`, `auth/credential-store.d.ts` and
`auth/stored-credentials.d.ts`, alongside their bundled implementations in
`@cursor/sdk@1.0.40`.

## Shared Claude credential refresh

The shared-store control uses the configuration fixture's local OAuth server
and model stand-in. It creates synthetic credentials and never contacts a real
account or model. Run it with:

```sh
OAR_CLAUDE_BIN=/path/to/claude pnpm tsx experiments/orientation/shared-refresh.ts
```

Claude 2.1.309 produced the following results on Linux with its native credential
file and on macOS 26.6.2 with an isolated writable Keychain. Both macOS controls
[passed in CI on October 24, 2026](https://github.com/botiverse/oar/actions/runs/40048891234/job/120736835442).

| Control | Refresh exchanges | Result |
| --- | --- | --- |
| Auth status and session initialize concurrently from one expired store | 1 | Auth status was logged in; the model request used the rotated access token and the turn completed. Both rotated tokens were persisted. |
| Auth status refreshes while the session's model request is held in flight | 1 | The server then rejects the old access token with 401. The session retries with the rotated token and completes without another refresh exchange. |

Both controls observed the native `.oauth_refresh.lock` and
`.storage-write.lock`. Inspection of this version's native implementation also
found a credential reread after acquiring the refresh lock. The probe records
token-match booleans and normalized lock names, not credential values. It does
not establish behavior for every provider failure or filesystem. The macOS
control also read the rotated tokens back from the same Keychain and confirmed
that a later auth-status process remained logged in. Locked or unavailable
login Keychains are outside this successful control.

The same two controls run in `sea-trial/vendor/claude-shared-refresh.vendor.test.ts`
for the Claude aimock backend on each CI platform. Linux and Windows use the
native credential file; macOS uses an isolated real Keychain. Store readback
and model-request token assertions are identical across platforms.
