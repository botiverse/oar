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
The built CLI's JSON is checked for synthetic secrets. Cursor uses the CLI's
installed SDK. `OAR_QODER_BIN` is optional; Claude and Codex are required.

Linux observations on October 24, 2026 used Claude 2.1.309, Codex 0.164.0,
Cursor SDK 1.0.40 and Qoder 1.1.78. Pi uses the repository's pinned SDK.

| Control | Observation |
| --- | --- |
| Codex stored API key, local | Native `login status` reports a configured key without network access. This is not remote validation. |
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
