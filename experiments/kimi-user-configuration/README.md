# Kimi temporary-home workspace probe

Run `pnpm tsx experiments/kimi-user-configuration/probe.ts` with Kimi Code
installed. It uses a local scripted model, synthetic state and temporary
homes. Linux was measured on 2026-10-23 with Kimi 2.3.1. File symlinks need
the platform's normal permission; no product symlink workaround is shipped.

Sharing the `credentials/` and `oauth/` directories and copying `device_id`
leaves the original session invisible to the isolated home. The probe then
links `sessions/`, `session_index.jsonl` and `workspaces.json`. This lets an
old session resume, but creating a session in another workspace replaces
the workspace-file symlink with a separate file. Only that separate catalog
contains the new workspace. The shared session index also records a path
under the temporary home.

Explicit cwd/id resume after removing the temporary home succeeded. That
does not make the split workspace catalog safe: the original native
catalog already lost visibility of the new workspace until a later explicit
open repaired it. The assertions keep both observations.

OAR refuses `userConfiguration: "exclude"` for Kimi. This experiment does
not claim OAuth refresh coverage; it rejects the proposed home-sharing
lifecycle before introducing it into the adapter.
