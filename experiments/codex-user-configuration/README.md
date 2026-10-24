# Codex temporary-home history probe

Run `pnpm tsx experiments/codex-user-configuration/probe.ts` with Codex
installed. This uses a local scripted provider, temporary homes and an
obviously synthetic auth file. It never reads a real login, changes the
user's history or writes native SQLite rows. File symlinks require the
platform's normal permission; Linux was measured on 2026-10-23, Codex
0.164.0.

The assertions reproduce this sequence:

1. Create and resume a session under the original temporary home.
2. Link only `auth.json` into another home. Resume reports
   `SessionNotFoundError`.
3. Link the session directory too. The original session resumes.
4. Set native `CODEX_SQLITE_HOME` to the original home and create a session
   through the isolated home. The original `thread/list` includes its id.
5. Remove the isolated home. Read the shared SQLite index without changing
   it: the new session's rollout path still names that removed home.
6. Its canonical history file remains, but native resume by id fails. The
   original session still resumes and its synthetic auth file is intact.

The list response can canonicalize its path even while the database keeps
the temporary one. Checking only `thread/list` would miss the failure.
The native SQLite-home setting is declared in the
[0.164.0 configuration schema](https://raw.githubusercontent.com/openai/codex/rust-v0.164.0/codex-rs/core/config.schema.json).

OAR therefore refuses `userConfiguration: "exclude"` for Codex. A persistent
clean home owned and supplied by a host is a future hypothesis, not current
support. This probe is about history lifecycle, not OAuth rotation or
cross-platform credential-store support.
