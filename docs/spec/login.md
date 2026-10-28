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
  app-server instead). Kimi is an explicit native exception to preservation
  on failure: it may mark a rejected refresh invalid or save new credentials
  before model provisioning fails. After a failed, timed-out or cancelled
  Kimi login, re-read `authStatus`; the outcome does not promise unchanged
  credentials. OAR does not roll back native writes. Cursor's SDK ignores an abort once the browser sign-in
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
  calls it on a person's request. `authStatus` never starts a login flow and returns no secret; a native
  status query may contact its service or refresh stored credentials.
- **Absent where oar never drives it.** A runtime whose login oar would
  refuse on every machine has no `login` member
  ([capabilities](../design/capabilities.md)): antigravity, whose terms do
  not allow it. `unsupported` is only for what the machine decides, its
  installation or its version.

## Environment

`LoginOptions.env`, `LogoutOptions.env` and `AuthStatusOptions.env` use the
same overlay as [`SessionOptions.env`](runtime-matrix.md#session-environment):
strings set variables, `null` removes them and omitted keys inherit. OAR does
not change the host's `process.env`. Pass the same map to authentication and
sessions to keep credential directories, proxies and executable lookup
consistent. Login and logout confirmation queries receive that map too.
OAR-owned overrides still win, including browser suppression and Claude's
`CLAUDECODE` removal.

Claude, Codex, Kimi and Qoder apply the overlay to their authentication processes.
Cursor's SDK runs in the host process: its three authentication methods reject
any nonempty `env` with `UnsupportedOptionError` (`option: "env"`) before
loading the SDK, as its sessions do. An empty map is a no-op. Runtime login is
separate from Pi's provider-auth facade. A runtime whose sessions refuse `env`
also refuses it for login, logout and authentication status.

### Explicit login-shell environment

`userShellEnvironment({ command?, args?, timeoutMs?, signal? })`, from the Node entry
`@botiverse/oar`, runs the configured `$SHELL` once and returns
`{ env, changedVariables }`. Calling authentication or opening a session never
invokes it implicitly. There is no cache or mutation of the host environment.

```ts
import { claudeRuntime, userShellEnvironment } from "@botiverse/oar";

const { env, changedVariables } = await userShellEnvironment({ timeoutMs: 10_000 });
const installation = await claudeRuntime.installation({ env });
if (installation.kind !== "available") { throw new Error("Claude is unavailable"); }
// interaction presents the login URL and requests the user's pasted code.
await claudeRuntime.login(installation, interaction, { env, openBrowser: false });
const session = await claudeRuntime.session(installation, { cwd, env });
// changedVariables contains names only. Never log or record env.
```

The helper starts an interactive login shell with closed stdin and no terminal,
then captures a JSON snapshot between random delimiters. By default it runs
`process.execPath -e` to write the snapshot. Node SEA hosts and compiled Bun
binaries cannot evaluate that script, so the default path refuses them before
any shell starts. Bun detection uses its
[documented standalone flag](https://bun.sh/docs/bundler/executables#detecting-standalone-mode-at-runtime);
older Bun builds without that flag are also refused on the default path.

A single-file host can instead provide its own executable and capture subcommand:

```ts
import { userShellEnvironment, writeShellEnvironmentCapture } from "@botiverse/oar";

// Register this handler for the host's internal capture subcommand.
function captureEnvironment(marker: string): void {
  writeShellEnvironmentCapture(marker);
}

// In the parent host, when explicitly requesting the login-shell snapshot:
const snapshot = await userShellEnvironment({
  command: process.execPath,
  args: ["internal-capture-environment"],
  timeoutMs: 10_000,
});
```

The host routes `internal-capture-environment <marker>` to that handler before
starting its normal application, then lets stdout drain and exits successfully.
The exported writer only writes `marker + JSON.stringify(process.env) + marker`
to stdout; call it only inside the private capture subprocess. It does not
start a shell, exit the process, parse arguments or log anything else.

With `command`, OAR runs `command ...args <marker>` inside the configured login
shell, quoting the executable and every argument as literal words in that
shell's dialect. It does not evaluate a command or argument as shell code.
Arguments default to an empty array; nonempty `args` without `command` are a
`RangeError`. OAR skips Node/SEA/Bun eligibility checks for this explicit path
and does not inject `ELECTRON_RUN_AS_NODE`, so the host's own subcommand routing
remains in control. The default evaluator still enables Electron's Node mode
and removes or restores that helper override in its result. Both paths share
the same parser, deadline, cancellation, output limit and environment comparison.

Profile chatter outside the delimiters is ignored. Bash and Zsh use POSIX
quoting; fish, Nushell and PowerShell use their own quoting and invocation.
The approach follows [VS Code's shell-environment capture](https://github.com/microsoft/vscode/blob/main/src/vs/platform/shell/node/shellEnv.ts).
A startup script that waits for interaction is bounded by the default ten-second
deadline. Cancellation or the deadline kills the capture's process group.
The combined stdout/stderr limit is 2 MiB. No shell output is forwarded, even
with `OAR_CHILD_STDERR=inherit`, and no partial environment is returned.

`env` is the complete shell snapshot, plus `null` for inherited variables the
shell removed, so it can be passed directly as an overlay. It contains secrets.
`changedVariables` contains only the names whose values changed: `HOME`, `PATH`,
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and upper/lowercase `HTTP_PROXY`, `HTTPS_PROXY`,
`ALL_PROXY`, `NO_PROXY`. Errors retain no output, environment values or native
error cause.

Failures reject with `UserShellEnvironmentError`; its `reason` is:

| Reason | Meaning |
| --- | --- |
| `no_node_runtime` | Node SEA or compiled Bun host, or a Bun version without a reliable standalone flag. Without `command`, the helper refuses before starting the shell. Supply a capture subcommand through `command`/`args`, or an env map directly. |
| `unsupported_platform` | Windows has no supported login-shell capture. Authentication env overlays still work on Windows. |
| `shell_not_set` | `$SHELL` is missing or blank. |
| `shell_unavailable` | The configured shell could not start. |
| `shell_failed` | The shell or capture command exited unsuccessfully or was signalled. A command not found inside a successfully started shell is also reported here; private shell diagnostics are not inspected. |
| `timed_out` | Shell startup or output collection exceeded the deadline. |
| `cancelled` | The caller aborted the operation. |
| `invalid_output` | No single complete, valid environment snapshot was returned. |
| `output_too_large` | Profile output and the snapshot exceeded the capture limit. |

The helper does not detect whether a user has a registered login session.
Under a service user without one, the returned environment may lack
`XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS`. Availability of a keychain or
secret service is not guaranteed. The host decides whether and when to use the
snapshot. It can also supply its own env map without calling this helper.

A host-provided capture subcommand must call
`writeShellEnvironmentCapture(marker)` before the host's startup code modifies
`process.env`. This preserves the environment produced by the login shell.

Native Bash, fish and Nushell capture is repeatable with
[`experiments/user-shell-environment.ts`](../../experiments/user-shell-environment.ts).
The custom command path also has executable-script regressions, including literal
arguments under Bash, fish and Nushell when those shells are installed.
PowerShell invocation is covered by quoting tests; native PowerShell capture
has not been verified. Installation, usage, model and inventory readers and
`orient` accept the same explicit `env`; in-process readers refuse an override
they cannot isolate. See [reader environments](orientation.md#environment).

## Interaction

`options.openBrowser` permits the runtime to open a browser on the machine
where it runs, and defaults to `true`. Pass `false` for a remote web login:
the runtime opens no local browser, and the caller can present the URL on
the person's device. URL and code events, pasted-code input and login
results are unchanged. `true` permits opening; it does not make a runtime
that normally opens no browser start one.

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
| browser_suppression_unavailable | Kimi cannot safely place its private browser helper on this platform or outside the working directory. Nothing is launched. |
| version_unsupported | The installed version predates the login path oar drives (for cursor, an SDK without `Cursor.auth`); `detail` names the floor. An unreadable version is tried, not refused. |

## Status results

`logged_in` (with `account` when the status names one), `logged_out`, or
`unknown` when the status query failed or answered in a way oar cannot read;
never a guess either way. `source` names the command (or SDK call) that
answered.

`LoginAccount.credential` optionally reports account versus API-key form;
`metering` independently reports plan versus usage billing. Unknown facts stay
absent. A configured key or stored login is not proof of remote validity.
Native status may refresh credentials; only `AuthStatusReader.localOnly: true`
declares no network, refresh or key-command execution. The
[orientation](orientation.md) local depth calls only declared readers.

## Per runtime

| Runtime | login drives | authStatus reads | Floor | Deadline |
| --- | --- | --- | --- | --- |
| claude | `claude auth login` over pipes: relays the URL, prompts `manual_code` for the `code#state` the page shows | `claude auth status --json` (`loggedIn`; exit 0 logged in, 1 logged out) | 2.1.126 | 15 min |
| codex | app-server `account/login/start { type: "chatgptDeviceCode" }`: relays the device code; codex polls | `codex login status` (exit 0 logged in; exit 1 with `Not logged in` logged out) | 0.118.0 | 16 min |
| cursor | `Cursor.auth.login({ openBrowser: false })` in process: relays the URL from `onLoginUrl`; the SDK polls; its save goes through a store oar passes, which refuses it once the login has ended | `Cursor.auth.status` (the stored login only, not `CURSOR_API_KEY`; `email` and the key's expiry) | `@cursor/sdk` 1.1.0 | 15 min |
| qoder | `qodercli login` over pipes: relays the authorization URL | `qodercli status --output json` (`logged_in`) | native 1.1.78 verified | 5 min |
| antigravity | no `login`: its terms do not allow a sign-in through a third-party tool ([page](../runtimes/antigravity.md)) | none | | |
| kimi | `kimi login [--region mainland-cn\|global]`: relays the device code; Kimi polls and provisions models | ACP `initialize` then `authenticate {methodId: "login"}`, no session; readiness, not proof of remote credential validity | 2.3.3 verified | 16 min |
| grok, opencode, pi | not yet | not yet | | |

The [runtime pages](../runtimes/README.md) record each login path's caveats.
Claude normally attempts to open a browser; `openBrowser: false` overrides
`BROWSER` only for its login child process, using a harmless executable.
This works from the existing login floor, 2.1.126. Codex's device-code login
never opens one, and OAR always passes `openBrowser: false` to Cursor's SDK,
regardless of this option. Qoder suppresses its browser with a per-login
`BROWSER=www-browser` override. Kimi ignores `BROWSER`: OAR places a private
no-op `xdg-open`, `open` or `powershell.exe` first on only the login child
PATH, then removes it after the child exits. Unsupported platforms or an
unusable temporary location return `browser_suppression_unavailable` before
launch. The other runtimes have no runtime login member.
Pi's provider logins are on `createPiProviderAuth`, whose
`loginProviders()` lists every provider pi's `/login` offers, with its methods
([pi page](../runtimes/pi.md#process-ownership-installation-login-and-account-usage)).

Kimi accepts `KimiLoginOptions.region` (`"mainland-cn"` or `"global"`) on
`kimiRuntime.login`. Omission preserves native resolution: endpoint env
overrides, persisted OAuth reference, install marker, then mainland China.
The native login does not report the selected region or account identity, so
OAR invents neither. Login can also write managed provider/model configuration
and the default model. The ACP authentication gate reads cached credentials
without refreshing them; OAR has not established that the whole ACP startup
is local-only, so it has no `localOnly` declaration. See [Kimi](../runtimes/kimi.md#runtime-login-and-logout)
for side effects and the repeatable local OAuth test.

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
- **The status decides.** After the logout ran, oar reads `authStatus`: when
  it reads logged out the result is `logged_out`, whatever the logout itself
  answered. A runtime that was logged out already answers in its own words
  (`Not logged in`), and the result is `logged_out`. A logout that succeeded
  while the status still reads logged in is `failed` / `still_logged_in`,
  with a `detail` saying what the status read; never `logged_out`. When the
  status cannot tell (`unknown`), the runtime's own report decides, as for a
  login: a logout that succeeded is `logged_out`, one that failed is its
  failure.
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
| logged_out | The runtime's status reads logged out after its logout ran, or, when the status cannot tell, the runtime reported that its logout succeeded. |
| failed | The logout failed, or it succeeded and the status still reads logged in; `reason` below, `detail` one line with secrets redacted. |
| unsupported | oar cannot drive this runtime's logout: `unsupported_installation` or `version_unsupported`, as for a login. |

| Failure reason | Meaning |
| --- | --- |
| still_logged_in | The runtime's logout succeeded, yet its status still reads logged in: credentials from the environment or another source. |
| rejected | The runtime reported that the logout failed. |
| timed_out | The deadline passed before the logout finished; it was stopped. |
| process_failed | The executable is no longer there (looked up before anything is spawned), or the logout could not start or ended without a result. |

| Runtime | logout drives | Server side | Floor | Deadline |
| --- | --- | --- | --- | --- |
| claude | `claude auth logout`, stdin closed | revokes the stored claude.ai OAuth refresh token, best effort | 2.1.41 | 60 s |
| codex | `codex logout`, stdin closed | revokes a stored ChatGPT login's token, best effort (from 0.122.0); an API key is only deleted | 0.15.0 | 60 s |
| cursor | `Cursor.auth.logout()` in process, with the SDK's own store | nothing: the minted key stays valid until it expires or is revoked in the dashboard | `@cursor/sdk` 1.1.0 | 20 s |
| kimi | ACP `initialize` then `logout`; reads authentication again afterward | removes the native credential slot and managed model configuration; no server-side revocation | 2.3.3 verified | 60 s |
| antigravity, grok, opencode, pi, qoder | no `logout` (pi's provider logouts are on `createPiProviderAuth`) | | | |

## CLI

`oar login`, `oar login --status` and `oar logout` run these from a
terminal; their flags, output and exit codes are in the
[CLI reference](../../packages/cli/README.md#commands).
