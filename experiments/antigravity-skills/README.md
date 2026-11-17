# Antigravity native skill catalog

2026-11-17, Linux x64. The independent reader uses the native JSON print
command, with an authentication guard and automatic updates disabled for its
children. The host gains the CLI's disclosed skill catalog without prompting
a model or guessing which directories the CLI loads.

## Native interface and mapping

`agy --output-format json --print=/skills` returns `command.name: "skills"`
and `command.data.skills`, with an empty conversation ID and zero turns.
The direct native result and OAR agree on metadata, plugin identity and
model-invocation flags in [catalog-controls.json](catalog-controls.json).
These controls use the minimum 1.5.0 and current 1.5.10 binaries, isolated
homes and a synthetic local Gemini provider. Each version passes both
catalog and unsigned-reader cases with zero model requests.

The catalog includes builtin, project `.agents/skills`, shared
`.gemini/skills`, `.gemini/config/skills`, CLI-specific skills and a synthetic
plugin. Those are fixture controls, not a complete directory-precedence claim.
OAR delegates discovery to the native command. `builtin: true` is the only
scope classification exposed here; `builtin: false` does not distinguish user
from project. Explicit `plugin` is preserved independently. Names and paths
are metadata, not instruction bodies.

The native command hides `disable-slash-command: true` files. It still lists
`disable-model-invocation: true` files, which OAR preserves. A successful catalog
is `partial:false`: it is complete for this disclosed native view, not a promise
that every installed file is listed. Unexpected payloads or native failures
are unavailable, not empty success.

An exploratory ACP `/skills` prompt made model requests, so it is not the
reader. The native print query above avoids that path. The guarded reader
first runs `agy models`, since unguarded unsigned print mode starts login.
The reader instead returns `unavailable/not_authenticated`; it does not ask
for credentials, open a login flow or scan directories as a fallback.

## Side effects and limits

[side-effects.json](side-effects.json) retains selected observations from
unproxied 1.5.10 startup. Both unsigned `models` and configured cold/warm skill
queries resolved `play.googleapis.com` and attempted TCP 443 connections.
The encrypted HTTP path and payload were not inspected; this does not identify
an account request or prove a telemetry payload was sent. The configured
provider was a closed local port, and the separate catalog fixture recorded
zero model requests. Real-account refresh behavior was not tested.

Native startup creates logs, extracts builtin skills, initializes project state
and creates an empty conversation database. Conversation summary, search and
parent tables stayed empty; SQLite search schema rows are not conversations.
Settings bytes changed formatting while parsed values stayed equal. No saved
conversation file or credential file appeared in the catalog controls; the
native conversations directory exists but is empty.
The desktop recent-conversations UI was not exercised. The evidence concerns
native disk records, not a GUI observation.

A first exploratory probe mistakenly set `AGY_CLI_DISABLE_AUTO_UPDATE=1`; agy
updated the disposable binary copy. That sample is not evidence of a pinned
version. The copies were restored and all admitted controls rerun with the
literal `true`. This native distinction is also reported in
[upstream issue 1046](https://github.com/google-antigravity/antigravity-cli/issues/1046).
The final reader overrides the variable only for discovery children. Binary
hashes remained unchanged in the minimum/latest controls; normal sessions keep
the user's updater policy.

These are native startup costs of an optional inventory query, not a local
no-network guarantee. No skill bodies are returned in the inventory. Custom
GEMINI_HOME is refused when print mode would inspect a different profile.
Windows/macOS behavior is covered by the existing Antigravity CI vendor job;
this report's completed native observations are Linux only.

## Reproduce

Use a disposable, pinned CLI copy. The repository's
[installer](../../.github/scripts/install-antigravity.mjs) verifies vendor archives.
The 1.5.10 archive came from the vendor's Linux manifest; the selected binary's
SHA-256 is in side-effects.json. The full raw artifacts are retained locally;
[manifest.json](manifest.json) fingerprints the material used here.

```sh
OAR_TEST=antigravity-aimock OAR_ANTIGRAVITY_BIN=/absolute/pinned/agy \
  pnpm vitest run sea-trial/vendor/antigravity-skills.vendor.test.ts
python3 experiments/antigravity-skills/side-effects.py /absolute/pinned/agy /tmp/agy-effects
```

The Python probe needs Linux `strace`. It uses temporary HOME/XDG state, a
missing D-Bus address, a no-op browser and a synthetic provider configuration.
It observes network without an outbound proxy; it sends no real credential.
Its full local traces contain synthetic file contents and should be reviewed
before sharing. Every subprocess is bounded; a timeout kills its owned process
group. The vendor tests retain catalog results under `OAR_TRIAL_RUN_DIR` and
assert no model requests, no body execution, unchanged binary/config values
and zero persisted conversation summaries.

The [unit regressions](../../tests/antigravity/skills.test.ts) cover payload
validation, sanitized errors, auth and scope refusal, version floor and one
abortable deadline. `oar inventory skills antigravity` exposes the same typed
result to CLI callers, including the [verified signed-out reason](cli-signed-out.json).
