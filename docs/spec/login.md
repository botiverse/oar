# Runtime login

`runtime.login(installation, interaction, options?)` signs an installation in
through the runtime's own login, without a terminal.
`runtime.authStatus(installation, options?)` says whether it is signed in.
Both are independent of sessions, like [account usage](account-usage.md) and
[updates](update.md). The
[TypeScript contract](../../packages/oar/src/contracts/login.ts) defines the
results; the interaction is the existing
[`ProviderLoginInteraction`](../../packages/oar/src/contracts/provider-auth.ts)
that pi's provider login already uses.

## Principles

- **The runtime's own login, its own store.** oar drives each CLI's login
  command or protocol and never handles tokens: they land where the runtime
  keeps them (`~/.claude`, `$CODEX_HOME`, the macOS Keychain).
- **No secret leaves a login.** Events carry only what a person opens or
  types: a sign-in URL, a device code and its URL, guidance. A code the
  person pastes back is written to the runtime's stdin and nowhere else; it
  is redacted, with anything token-shaped, from every `detail` oar reports.
  Nothing a login prints is logged.
- **Never sign out first.** A login that fails, times out or is cancelled
  leaves the previous sign-in as it was, so oar never drives a path that
  clears the stored credentials before the new ones exist (`codex login`
  does; oar uses codex's app-server instead).
- **Bounded and cancellable.** Each runtime has a deadline (the person's time
  in the browser included); `options.timeoutMs` overrides it. Aborting
  `interaction.signal` stops the login process and everything it started (its
  process group on POSIX, its process tree on Windows) and resolves
  `cancelled`.
- **One login per runtime at a time** in a process; a second resolves
  `failed` / `busy` without starting anything. Logins from other processes on
  the same machine are not coordinated.
- **The status decides.** A login that the runtime reports as successful is
  confirmed with the runtime's own status query: one that still reads signed
  out is `failed` / `not_signed_in`, not a sign-in.
- **`login` changes the machine.** oar never calls it on its own; a host
  calls it on a person's request. `authStatus` is read only and cheap: the
  runtime's local status query, no login flow, no secret in the result.

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
| logged_in | Signed in; `account` carries what the runtime's status reports (`email`, `plan`, `method`). |
| failed | Not signed in; `reason` below, `detail` in the runtime's words with secrets redacted. |
| cancelled | `interaction.signal` aborted; the login process was stopped. |
| unsupported | oar cannot drive this runtime's login; `reason` below. |

| Failure reason | Meaning |
| --- | --- |
| busy | Another login for this runtime is running in this process. |
| timed_out | The deadline passed; the login process was stopped. |
| rejected | The runtime reported that the sign-in failed. |
| not_signed_in | The runtime reported success, yet its status says signed out. |
| interaction_failed | The caller's `prompt` or `onEvent` threw. |
| process_failed | The login process could not start, or ended without a result. |

| Unsupported reason | Meaning |
| --- | --- |
| unsupported_installation | Not a machine-installed executable. |
| version_unsupported | The installed version predates the login path oar drives; `detail` names the floor. An unreadable version is tried, not refused. |
| terms_of_service | The runtime's terms do not allow signing in through a third-party tool. |

## Status results

`signed_in` (with `account` when the status names one), `signed_out`, or
`unknown` when the status query failed or answered in a way oar cannot read;
never a guess either way. `source` names the command that answered.

## Per runtime

| Runtime | login drives | authStatus reads | Floor | Deadline |
| --- | --- | --- | --- | --- |
| claude | `claude auth login` over pipes: relays the URL, prompts `manual_code` for the `code#state` the page shows | `claude auth status --json` (`loggedIn`; exit 0 signed in, 1 signed out) | 2.1.126 | 15 min |
| codex | app-server `account/login/start { type: "chatgptDeviceCode" }`: relays the device code; codex polls | `codex login status` (exit 0 signed in; exit 1 with `Not logged in` signed out) | 0.118.0 | 16 min |
| antigravity | none: `unsupported` / `terms_of_service` | none | | |
| cursor, grok, kimi, pi | not yet | not yet | | |

The [runtime pages](../runtimes/README.md) record each login path's caveats.
Cursor waits for its adapter's move to the Cursor SDK, whose login is its
own. Pi's provider logins are on `createPiProviderAuth`.

## CLI

`oar login <runtime>` runs the login in the terminal: it prints the URL or the
device code, and reads a pasted code from stdin when the runtime asks for one.
Ctrl-C cancels. The exit code is 0 when signed in, 130 when cancelled, 1
otherwise. `oar login [runtime] --status` only reports the status of one or
every runtime. `--json` prints events, prompts and the result (or the status
reports) as JSON; `--timeout <ms>` bounds the login or each status query.
