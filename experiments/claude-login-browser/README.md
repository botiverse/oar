# Claude login browser control

Run the real Claude login and OAR driver against a local OAuth stand-in:

```sh
pnpm exec tsx experiments/claude-login-browser/probe.ts /absolute/path/to/claude 2.1.304
```

Alternatively, install the official package in an isolated directory and
pass `--package /path/to/install 2.1.304`. The probe selects its platform's
native executable. It requires `openssl`; on Windows it also uses the
runner's .NET Framework C# compiler to build a harmless browser marker.
Use a disposable macOS runner because Claude stores its login in Keychain.
If that runner cannot use its job-owned temporary keychain, the explicit
`--macos-keychain-unavailable` flag runs only the browser and code-exchange
checks. It retains the actual login/status outcomes and prints
`environment_skip` when login completion is unverified. It never
turns an unavailable keychain into a successful login assertion, and other
platforms reject the flag.

Each run uses an empty home and Claude configuration, a fresh temporary
certificate trusted only by the child, and an HTTP proxy that serves local
responses and never forwards requests. No inherited account credentials
enter the child. Authorization codes, access tokens, refresh tokens and the
account are synthetic. There is no model request or human sign-in.

The default case supplies a marker executable as `BROWSER` and requires
exactly one call, a positive control for observing browser launches. The
`openBrowser: false` case inherits the same marker and requires zero calls.
Platform default openers are guarded too. Each case requires one `auth_url`,
one pasted-code prompt, a successful PKCE/state-checked token exchange,
`logged_in` and a separate native status reading `logged_in`. Code input is
delayed briefly so finishing too quickly cannot hide the browser attempt.
A third case makes the browser marker exit 1 and requires that Claude does
not invoke a default opener afterward. This explicitly watches the failure
behavior during daily Linux checks. Windows also runs its system
`hostname.exe` with a URL and stdin left open: it must exit within five
seconds without waiting for input. Its exit code may be nonzero; the native
login must still complete without a default-browser attempt.

Run this probe on Linux whenever the daily runtime check finds a new Claude
version, and record the result in that day's `runtime-version-checks` report.
It checks that Claude still honors `BROWSER` and does not try a default
opener after the selected program exits. Recheck macOS and Windows when the
opener mapping changes. This native experiment stays outside `pnpm check`. The output contains
counts, status kinds and request paths, not tokens or authorization URLs.
The source is a protocol stand-in, not evidence about a real provider's
account policy or consent page.

## Observed, 2026-10-20

Every row received one URL, one pasted-code prompt and one successful
PKCE/state-checked exchange. The failing-browser control made exactly one
browser call, with no additional call to the platform default opener.

| Platform | Claude | Default browser calls | Calls with false | Login completion and subsequent status |
| --- | --- | --- | --- | --- |
| Linux x64 | 2.1.126 | 1 | 0 | logged_in |
| Linux x64 | 2.1.304 | 1 | 0 | logged_in |
| Windows x64 | 2.1.126 | 1 | 0 | logged_in |
| Windows x64 | 2.1.304 | 1 | 0 | logged_in |
| macOS 26 Arm64 | 2.1.126 | 1 | 0 | Browser verified; completion unverified in CI keychain environment |
| macOS 26 Arm64 | 2.1.304 | 1 | 0 | Browser verified; completion unverified in CI keychain environment |
| macOS 15 Intel | 2.1.126 | 1 | 0 | Browser verified; completion unverified in CI keychain environment |
| macOS 15 Intel | 2.1.304 | 1 | 0 | Browser verified; completion unverified in CI keychain environment |

Windows `hostname.exe` exited 1 promptly with a URL argument while stdin
remained open. Both Claude versions ignored that status, opened no browser
with `false`, and completed the native login and status query. Evidence:
[Linux and Windows run, 376b2ff](https://github.com/botiverse/oar/actions/runs/39494924607).

macOS used a job-owned temporary keychain, deleted after each job. The
macOS 26 runner could not unlock the newly created keychain. The macOS 15
runner passed its keychain read/write preflight, but native login still did
not complete: 2.1.304 rejected saving credentials with a locked-keychain
message and its status was `logged_out`; 2.1.126 timed out after the code
exchange while its separate status read was `logged_in`. The cause of that
2.1.126 timeout was not established. The explicit environment skip preserves
these outcomes and does not count them as successful logins. Browser calls
and code exchange were verified in all three modes on both macOS images.
Evidence: [macOS run, c7473ee](https://github.com/botiverse/oar/actions/runs/39495577083).

Both tested versions honor `BROWSER` on all three platforms, so the existing
2.1.126 login floor remains sufficient. The temporary Actions workflow used
to gather this evidence is removed; normal CI and `pnpm check` do not run
these native login experiments.
