# Claude limit-reset onboarding

Claude Code 2.1.322 on Linux draws first-run onboarding before folder trust
when its config has a stored account but no onboarding completion. The
limit-reset driver previously waited for the prompt until its 30 s startup
cutoff, then reported an unknown startup screen.

The driver now accepts only the complete recorded default Dark theme page
and Security notes, each once after three seconds of unchanged screen.
The notice contains two statements and a continuation key, no consent or
configuration choice. Unknown or changed onboarding receives no keys and
returns `startup_failed` with `startup.screen: "onboarding"`. Completion
observed at trust or the empty prompt adds `onboardingCompleted: true` to
the inspection or redemption result.

## Reproduce

On Linux with `script`, OpenSSL and an official Claude Code 2.1.322 binary:

```sh
pnpm tsx experiments/claude-reset-onboarding/probe.ts /absolute/path/to/claude
pnpm exec vitest run tests/claude/claude-limit-reset-onboarding.test.ts
```

The probe starts the real executable through OAR's terminal driver. Each
case has a temporary HOME and empty project, with `.claude.json` containing
only a synthetic `oauthAccount` at launch. The positive case has a separate
synthetic native credential file; the negative case supplies a synthetic
OAuth token through the environment instead. No real credentials are
inherited. A local TLS proxy answers requests without forwarding them; its
certificate trust is scoped to the child. The probe stops at the prompt
with `usage_unread`, intentionally withholding the fresh usage answer so
no `/limit-reset` command or redemption request is sent. Processes and
temporary files are removed on completion or assertion failure.

## Observations

The [selected output](selected.json) records native version, keys, result,
config field names and request routes. No identifiers or tokens are retained.
The [theme](../../tests/claude/limit-reset-fixtures/onboarding-theme.txt) and
[notice](../../tests/claude/limit-reset-fixtures/onboarding-security.txt)
are native terminal frames, not reconstructed text.

| Case | Native path | OAR input and result |
| --- | --- | --- |
| Stored synthetic sign-in | Theme, Security notes, folder trust, empty prompt | Enter, Enter, Down, Enter; `usage_unread`, `onboardingCompleted: true` |
| Environment token only | Theme, login-method choice | Enter on theme only; `startup_failed/onboarding`; no completion claim |
| Altered/extra page text (screen replay) | Different default, terms, data-sharing choice, changed notice or additional page | No input on that page, typed startup failure within settle windows |

The default theme changes no config fields. Comparing the config just
before the security-notice Enter with the config at folder trust yields
exactly `hasCompletedOnboarding: true` and `lastOnboardingVersion: "2.1.322"`.
There is no `theme` field. These are the onboarding writes, not all writes
made by a fresh CLI: native initialization/profile loading already adds or
updates other fields before the theme page, listed separately in the result.
Folder-trust persistence is also separate from onboarding.

The recognizer checks all screen content, including the choice markers and
preview, normalizing whitespace and the welcome version only. It does not
accept a page merely because its title is familiar. Screen changes during
settlement are rechecked; an Enter is never repeated while the same page
remains visible. Completion requires observing the next recognised trust
or empty prompt, not merely sending Enter.

## Native skip controls

The 2.1.322 executable's `--help` and embedded onboarding entry were
inspected. No documented onboarding-skip flag was found. The entry skips
when the persisted `hasCompletedOnboarding` is true; the internal
`CLAUDE_CODE_POWERUP_ONBOARDING` values `banner` and `step` instead force
onboarding. OAR uses neither a config edit nor an undocumented skip switch.
The native page list can also contain API-key approval, OAuth and terminal
setup; those are not the recorded default pages and OAR refuses them.

This probe disables nonessential traffic to isolate onboarding. It does
not change production environment handling or establish that real limit
inspection is free of model requests. Remote limit-dialog label changes
remain a separate case in the same task.
