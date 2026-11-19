# Which runtimes remember the previous account?

Linux x64, 2026-11-19. Each control used a separate temporary home. The
identity came from the native status command or control reply. The probes
used synthetic profiles or local services and submitted no model prompts.

| Runtime | Native observation | Previous identity |
| --- | --- | --- |
| Grok 1.0.89 | Before expiry, `grok models` reported a login and ACP `_x.ai/auth/info` returned the fixture email with method `cached_token`. After expiry the CLI reported signed out and billing returned ACP error `-32000`. Auth info still returned the same email without an active method. After `grok logout`, auth info also lost the email. | Email on `logged_out` and `reauth_required` after expiry. Absent after logout. |
| Codex 0.169.1 | With a local ChatGPT fixture, app-server `account/read` initially named the account. The local OAuth endpoint rejected refresh. `account/read {refreshToken: true}`, the next ordinary read, and the read after `account/logout` all returned `account: null`. | Absent on these reads. |
| Cursor SDK 1.4.1 | `Cursor.auth.status()` named the email before expiry. After expiry and after explicit SDK logout its only field was `status: "logged-out"`. | Absent. |
| Kimi 2.6.3 | After the local server accepted refresh, native Web `/oauth/userinfo` returned the fixture nickname. After rejection both that route and `/oauth/usage` returned an error. | Absent after rejection. |
| Devin 3000.12.57 | After a successful local OAuth exchange, `devin auth status` included a user section with the fixture email. A server-side 401 and subsequent explicit logout both removed that section from the output. | Absent in both cases. |
| CodeBuddy 2.184.0 | In a home with no environment key or browser session, stream-json `logout` succeeded and `initialize.account` was null both before and after. | No identity in the signed-out reply. A separate control returned an account object with an environment key still configured. Browser-session expiry was untested. |
| Antigravity 1.5.12 | ACP `logout` removed a placeholder in the isolated home. The subsequent `agy models` exited 1 and asked the user to sign in. | No identity in the signed-out reply. Google OAuth expiry was untested. |
| Qoder 1.1.92 | In an empty home, `qodercli status --output json` returned only `version`, `logged_in: false` and `allow_byok`. The published CLI bundle's signed-out branch may also add an invalidation reason and message, then returns before assigning `email` or `username`. | No identity in the signed-out branch. Interactive sign-out was untested. |

[Claude's three controls](../claude-last-account/README.md) separately cover
its retained native account profile, rejected refresh and explicit logout.

## Reproducing the observations

- [Grok](grok.ts) exercises OAR status and usage against the native binary before expiry, after expiry and after explicit logout. Run `pnpm tsx experiments/remembered-accounts/grok.ts /absolute/path/to/grok`.
- [Cursor](../cursor-login/probe.ts) uses the SDK’s own store and an isolated loopback mock. Run `pnpm tsx experiments/cursor-login/probe.ts`.
- [Kimi](kimi.ts) runs the same native Web reads after an accepted and a rejected refresh. Run `pnpm tsx experiments/remembered-accounts/kimi.ts /absolute/path/to/kimi`.
- [Devin](../devin-acp/login-probe.ts) runs the local OAuth exchange, rejected-key check and logout. Set `OAR_DEVIN_BIN` to the binary and run `pnpm tsx experiments/devin-acp/login-probe.ts`.
- [Antigravity](../antigravity-login/logout-probe.py) sends ACP logout and checks subsequent CLI status. Run `python3 experiments/antigravity-login/logout-probe.py /absolute/path/to/agy`.
- For CodeBuddy, send stream-json control requests of subtype `initialize`, `logout`, then `initialize` in a disposable home with no inherited login environment. Inspect only whether the response has a null `account`.
- For Qoder, inspect the JSON keys from the status command in a disposable home. In `@qoder-ai/qodercli@1.1.92/bundle/qodercli.js`, the projection containing `allow_byok` and `getAuthInvalidationSnapshot` shows both native branches.
- For Codex, use the local ChatGPT profile from the [quota probe](../codex-quota-errors/probe.ts) in a disposable `CODEX_HOME`. Point `chatgpt_base_url` and the native refresh and revoke URL overrides at the fixture. Return the fixture account from `/wham/accounts/check` and reject refresh with HTTP 401. On the same app-server, compare `account/read` before refresh, with `refreshToken: true`, and after native logout.
