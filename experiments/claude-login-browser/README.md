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
Windows also runs its system `ipconfig.exe` with a URL and stdin left open:
it must exit successfully within five seconds, without waiting for input.

Run this probe on Linux whenever the daily runtime check finds a new Claude
version, and record the result in that day's `runtime-version-checks` report.
It checks that Claude still honors `BROWSER` and does not try a default
opener after the selected program exits. Recheck macOS and Windows when the
opener mapping changes. This native experiment stays outside `pnpm check`. The output contains
counts, status kinds and request paths, not tokens or authorization URLs.
The source is a protocol stand-in, not evidence about a real provider's
account policy or consent page.

## Observed, 2026-10-20

| Platform | Claude | Default browser calls | Calls with false | Pasted code and subsequent status |
| --- | --- | --- | --- | --- |
| Linux x64 | 2.1.126 | 1 | 0 | logged_in |
| Linux x64 | 2.1.304 | 1 | 0 | logged_in |

macOS and Windows native runs are pending. These two Linux versions both
honor `BROWSER`; the existing 2.1.126 login floor remains sufficient.
