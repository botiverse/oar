# Runtime login

`runtime.login(installation, interaction, options?)` logs an installation in
through the runtime's own login, without a terminal.
`runtime.authStatus(installation, options?)` says whether it is logged in.
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
  person pastes back is written to the runtime's stdin and nowhere else. A
  `detail` is one line in the runtime's own words (its failure message, never
  a log or stderr tail), with every pasted code and anything token-shaped
  redacted. Nothing a login process prints reaches the host's output:
  `OAR_CHILD_STDERR=inherit` does not apply to it.
- **Never log out first.** oar never drives a path that clears the stored
  credentials before the new ones exist (`codex login` does; oar uses codex's
  app-server instead). `timed_out` and `cancelled` therefore mean the previous
  login is untouched.
- **Success is final.** Once the runtime reports success it has stored the
  new login, so a deadline or an abort that arrives after that (claude flushes
  telemetry for a few seconds before it exits) yields neither `timed_out` nor
  `cancelled`: the status query decides, and when it cannot answer (it
  failed, or the caller aborted) the result is `logged_in` without an
  account.
- **The status decides.** A login that the runtime reports as successful is
  confirmed with the runtime's own status query: one that still reads logged
  out is `failed` / `not_logged_in`. The query honours the caller's abort.
- **Bounded and cancellable.** Each runtime has a deadline (the person's time
  in the browser included); `options.timeoutMs` overrides it. Aborting
  `interaction.signal` stops the login process and everything it started (its
  process group on POSIX, its process tree on Windows) and resolves
  `cancelled`. The deadline bounds the login, not the call: the status query
  after a success (up to 20 s) and the 10 s grace a process that ignores the
  stop signal gets can take a call past `timeoutMs`.
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
| logged_in | Logged in; `account` carries what the runtime's status reports (`email`, `plan`, `method`). |
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
| unsupported_installation | Not a machine-installed executable. |
| version_unsupported | The installed version predates the login path oar drives; `detail` names the floor. An unreadable version is tried, not refused. |

## Status results

`logged_in` (with `account` when the status names one), `logged_out`, or
`unknown` when the status query failed or answered in a way oar cannot read;
never a guess either way. `source` names the command that answered.

## Per runtime

| Runtime | login drives | authStatus reads | Floor | Deadline |
| --- | --- | --- | --- | --- |
| claude | `claude auth login` over pipes: relays the URL, prompts `manual_code` for the `code#state` the page shows | `claude auth status --json` (`loggedIn`; exit 0 logged in, 1 logged out) | 2.1.126 | 15 min |
| codex | app-server `account/login/start { type: "chatgptDeviceCode" }`: relays the device code; codex polls | `codex login status` (exit 0 logged in; exit 1 with `Not logged in` logged out) | 0.118.0 | 16 min |
| antigravity | no `login`: its terms do not allow a sign-in through a third-party tool ([page](../runtimes/antigravity.md)) | none | | |
| cursor, grok, kimi, opencode, pi | not yet | not yet | | |

The [runtime pages](../runtimes/README.md) record each login path's caveats.
Cursor waits for its adapter's move to the Cursor SDK, whose login is its
own. Pi's provider logins are on `createPiProviderAuth`.

## CLI

`oar login <runtime>` runs the login in the terminal: it prints the URL or the
device code, and reads a pasted code from stdin when the runtime asks for one,
without echoing it. Ctrl-C cancels. The exit code is 0 when logged in, 130
when cancelled, 1 otherwise. `oar login [runtime] --status` only reports the
status of one or every runtime. `--json` prints events, prompts and the result
(or the status reports) as JSON; `--timeout <ms>` bounds the login or each
status query.
