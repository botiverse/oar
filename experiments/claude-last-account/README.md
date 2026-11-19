# Claude's remembered account after a failed refresh

Observed on Linux with Claude Code 2.1.327 on 2026-11-19. Each control has
its own home, synthetic profile and OAuth grant. A local stand-in answers
all HTTP requests. The probe issues status and control queries without a
model prompt.

| Operation | Native auth status | `initialize.account` | Native `oauthAccount` after query | `get_usage.rate_limits_available` |
| --- | --- | --- | --- | --- |
| Expired access token, refresh rejected with `invalid_grant` | Logged out, no email | No email | Previous email and display name retained | false |
| Expired access token, refresh accepted | Logged in with email | Email | Email and display name retained | true |
| Explicit `claude auth logout` | Logged out, no email | No email | Removed | false |

The rejected and accepted controls each made one token exchange. Explicit
logout revoked the synthetic grant. The probe checks the public OAR status
and absence of a remembered account after logout, exercising both default
and overridden configuration directories.

Run the [probe](probe.ts) with an installed Linux binary:

```sh
pnpm tsx experiments/claude-last-account/probe.ts /absolute/path/to/claude
```
