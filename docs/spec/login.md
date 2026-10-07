# Runtime login

`runtime.login(installation, interaction, options?)` logs an installation in
through the runtime's own login, without a terminal.
`runtime.logout(installation, options?)` logs it out through the runtime's
own logout ([below](#logout)).
`runtime.authStatus(installation, options?)` says whether it is logged in.
All three are independent of sessions, like [account usage](account-usage.md) and
[updates](update.md). The
[TypeScript contract](../../packages/oar/src/contracts/login.ts) defines the
results; the interaction is the existing
[`ProviderLoginInteraction`](../../packages/oar/src/contracts/provider-auth.ts)
that pi's provider login already uses.

## Principles

- **The runtime's own login, its own store.** oar drives each runtime's login
  command, protocol or SDK call and never handles tokens: they land where the
  runtime keeps them (`~/.claude`, `$CODEX_HOME`, the macOS Keychain,
  `~/.cursor/sdk/auth.json`). Cursor's SDK runs in the host process and saves
  through a store oar passes, which hands what it saves to the SDK's own file
  store unread.
- **No secret leaves a login.** Events carry only what a person opens or
  types: a sign-in URL, a device code and its URL, guidance. A code the
  person pastes back is written to the runtime's stdin and nowhere else. A
  `detail` is one line in the runtime's own words (its failure message, never
  a log or stderr tail), with every pasted code and anything token-shaped
  redacted. Nothing a login process prints reaches the host's output:
  `OAR_CHILD_STDERR=inherit` does not apply to it. (Cursor's SDK, in the host
  process, prints nothing once oar takes its URL, except a warning, with no
  secret in it, when a backend lacks `POST /auth/poll`.)
- **Never log out first.** oar never drives a path that clears the stored
  credentials before the new ones exist (`codex login` does; oar uses codex's
  app-server instead). `timed_out` and `cancelled` therefore mean the previous
  login is untouched. Cursor's SDK ignores an abort once the browser sign-in
  is done and saves its new key anyway; the store oar passes it refuses that
  save once the login has ended.
- **Success is final.** Once the runtime reports success it has stored the
  new login, so a deadline or an abort that arrives after that (claude flushes
  telemetry for a few seconds before it exits; cursor's SDK may still be
  writing its key) yields neither `timed_out` nor `cancelled`: the status
  query decides, and when it cannot answer (it failed, or the caller aborted)
  the result is `logged_in` without an account.
- **The status decides.** A login that the runtime reports as successful is
  confirmed with the runtime's own status query: one that still reads logged
  out is `failed` / `not_logged_in`. The query honours the caller's abort.
- **Bounded and cancellable.** Each runtime has a deadline (the person's time
  in the browser included); `options.timeoutMs` overrides it. Aborting
  `interaction.signal` stops the login process and everything it started (its
  process group on POSIX, its process tree on Windows; for cursor, the SDK's
  poll and any save after it) and resolves `cancelled`. The deadline bounds
  the login, not the call: the status query after a success (up to 20 s) and
  the 10 s grace a process that ignores the stop signal gets can take a call
  past `timeoutMs`.
- **Not serialized.** oar does not stop two logins from running at once;
  whether a host allows that is its own policy.
- **`login` changes the machine.** oar never calls it on its own; a host
  calls it on a person's request. `authStatus` is read only and cheap: the
  runtime's local status query, no login flow, no secret in the result.
- **Absent where oar never drives it.** A runtime whose login oar would
  refuse on every machine has no `login` member
  ([capabilities](../design/capabilities.md)): antigravity, whose terms do
  not allow it. `unsupported` is only for what the machine decides, its
  installation or its version.

## Interaction

The driver calls `interaction.onEvent` with:

| Event | When |
| --- | --- |
| `auth_url` | A URL to open and sign in at; `instructions` says what follows (a code to paste back, or nothing). |
| `device_code` | A code to enter at `verificationUri`. |
| `info` | The runtime's guidance, e.g. a setting the account needs. |

When the runtime needs a code pasted back, it asks
`interaction.prompt({ kind: "manual_code", message, placeholder })` and
writes the answer (whitespace removed) to the runtime's stdin. A code the
runtime rejects as malformed asks again. A prompt still open when the login
settles (the browser finished the sign-in on this machine) is moot; the
caller closes it. A prompt or event handler that throws stops the login with
`failed` / `interaction_failed`.

## Login results

| Kind | Meaning |
| --- | --- |
| logged_in | Logged in; `account` carries what the runtime's status reports (`email`, `plan`, `method`, and `expiresAt` when the stored credential expires and the runtime does not renew it: cursor's key). |
| failed | Not logged in; `reason` below, `detail` one line in the runtime's words with secrets redacted. |
| cancelled | `interaction.signal` aborted before the runtime reported success; the login process was stopped. |
| unsupported | oar cannot drive this runtime's login; `reason` below. |

| Failure reason | Meaning |
| --- | --- |
| timed_out | The deadline passed before the runtime reported success; the login process was stopped. |
| rejected | The runtime reported that the login failed. |
| not_logged_in | The runtime reported success, yet its status says logged out. |
| interaction_failed | The caller's `prompt` or `onEvent` threw. |
| process_failed | The executable is no longer there (looked up as the installation probe does, before anything is spawned, so alike on every platform; `detail` names the command), the login process could not start, or it ended without a result. |

| Unsupported reason | Meaning |
| --- | --- |
| unsupported_installation | Not the installation the login runs on: a machine-installed executable for claude and codex, the bundled SDK for cursor. |
| version_unsupported | The installed version predates the login path oar drives (for cursor, an SDK without `Cursor.auth`); `detail` names the floor. An unreadable version is tried, not refused. |

## Status results

`logged_in` (with `account` when the status names one), `logged_out`, or
`unknown` when the status query failed or answered in a way oar cannot read;
never a guess either way. `source` names the command (or SDK call) that
answered.

## Per runtime

| Runtime | login drives | authStatus reads | Floor | Deadline |
| --- | --- | --- | --- | --- |
| claude | `claude auth login` over pipes: relays the URL, prompts `manual_code` for the `code#state` the page shows | `claude auth status --json` (`loggedIn`; exit 0 logged in, 1 logged out) | 2.1.126 | 15 min |
| codex | app-server `account/login/start { type: "chatgptDeviceCode" }`: relays the device code; codex polls | `codex login status` (exit 0 logged in; exit 1 with `Not logged in` logged out) | 0.118.0 | 16 min |
| cursor | `Cursor.auth.login({ openBrowser: false })` in process: relays the URL from `onLoginUrl`; the SDK polls; its save goes through a store oar passes, which refuses it once the login has ended | `Cursor.auth.status` (the stored login only, not `CURSOR_API_KEY`; `email` and the key's expiry) | `@cursor/sdk` 1.0.36 | 15 min |
| antigravity | no `login`: its terms do not allow a sign-in through a third-party tool ([page](../runtimes/antigravity.md)) | none | | |
| grok, kimi, opencode, pi | not yet | not yet | | |

The [runtime pages](../runtimes/README.md) record each login path's caveats.
Pi's provider logins are on `createPiProviderAuth`.

## Logout

`runtime.logout(installation, options?)` signs the installation out the way
the runtime itself does, and resolves a `LogoutResult`. It is absent on a
runtime oar does not sign in.

- **The runtime's own logout, never a file.** oar runs the runtime's logout
  command or SDK call (`claude auth logout`, `codex logout`,
  `Cursor.auth.logout`) and never deletes a credential file or Keychain entry
  behind its back. What a logout removes, and whether it also revokes the
  credential on the vendor's side, is the runtime's own behaviour; each
  runtime page says what it does.
- **The status decides.** After the logout ran, oar reads `authStatus`:
  `logged_out` only when it reads logged out, whatever the logout itself
  answered. A runtime that was logged out already answers in its own words
  (`Not logged in`), and the result is `logged_out`. A logout that succeeded
  while the status still reads logged in is `failed` / `still_logged_in`,
  with a `detail` saying what the status read; never `logged_out`.
- **The environment is not touched.** A credential outside the runtime's
  own store, such as `ANTHROPIC_API_KEY` or `CURSOR_API_KEY`, stays. Where
  the runtime's status reads it (claude's does), the result is
  `still_logged_in`; where it does not (codex's and cursor's), the result is
  `logged_out` while the runtime may still use the variable.
- **No secret leaves a logout,** as for a login: nothing the logout process
  prints reaches the host's output (its stdin is closed, and
  `OAR_CHILD_STDERR=inherit` does not apply to it), and a `detail` is one
  line in the runtime's own words, redacted.
- **Bounded.** Each runtime has a deadline for its logout;
  `options.timeoutMs` overrides it. Past it the logout process and everything
  it started are stopped (its process group on POSIX, its tree on Windows),
  and the status still decides. The status query after it has its own
  deadline (20 s). There is no abort signal: a logout is short.
- **`logout` changes the machine.** oar never calls it on its own, and does
  not serialize it against a login; that is the host's policy.

| Kind | Meaning |
| --- | --- |
| logged_out | The runtime's status reads logged out after its logout ran. |
| failed | The status does not read logged out; `reason` below, `detail` one line with secrets redacted. |
| unsupported | oar cannot drive this runtime's logout: `unsupported_installation` or `version_unsupported`, as for a login. |

| Failure reason | Meaning |
| --- | --- |
| still_logged_in | The runtime's logout succeeded, yet its status still reads logged in: credentials from the environment or another source. |
| rejected | The runtime reported that the logout failed. |
| timed_out | The deadline passed before the logout finished; it was stopped. |
| process_failed | The executable is no longer there (looked up before anything is spawned), the logout could not start or ended without a result, or the status after a successful logout gave no answer. |

| Runtime | logout drives | Server side | Floor | Deadline |
| --- | --- | --- | --- | --- |
| claude | `claude auth logout`, stdin closed | revokes the stored claude.ai OAuth refresh token, best effort | 2.1.41 | 60 s |
| codex | `codex logout`, stdin closed | revokes a stored ChatGPT login's token, best effort (from 0.122.0); an API key is only deleted | 0.15.0 | 60 s |
| cursor | `Cursor.auth.logout()` in process, with the SDK's own store | nothing: the minted key stays valid until it expires or is revoked in the dashboard | `@cursor/sdk` 1.0.36 | 20 s |
| antigravity, grok, kimi, opencode, pi | no `logout` (pi's provider logouts are on `createPiProviderAuth`) | | | |

## CLI

`oar login <runtime>` runs the login in the terminal: it prints the URL or the
device code, and reads a pasted code from stdin when the runtime asks for one,
without echoing it. Ctrl-C cancels. The exit code is 0 when logged in, 130
when cancelled, 1 otherwise. `oar login [runtime] --status` only reports the
status of one or every runtime. `--json` prints events, prompts and the result
(or the status reports) as JSON; `--timeout <ms>` bounds the login or each
status query.

`oar logout <runtime>` runs the runtime's logout and prints the result; the
exit code is 0 when logged out and 1 otherwise, as for `oar login`. `--json`
prints the result as JSON; `--timeout <ms>` bounds the logout.
