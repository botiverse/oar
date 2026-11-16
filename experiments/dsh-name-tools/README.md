# DSH session names and native tool denial

Observed on Linux x64, 2026-11-16, with published DSH 0.2.2-rc.1 and
minimum 0.2.1-rc.5. Each version passed seven native regression cases using
an isolated home and a loopback synthetic provider. No account was used.

## Result

OAR supplies `name` through the owned agent's native `sessionTitle` service.
It reads the saved title first, preserving an existing title on resume, and
names an unnamed session only after tool-denial, adapter-route and session-ID
validation succeeds. This occurs before the host's first prompt. Unrelated
native creation hooks can start their own work earlier. Blank or NUL names
fail before launching DSH.

`disallowedTools` uses native scoped `tools.restrict` during setup. The bridge
confirms after creation hooks that each denied tool remains unavailable.
Unknown names, reserved tools such as `run_code`, missing services and a hook
that shadows a denied tool fail with `UnsupportedOptionError` at open. This
is native tool visibility, not an OS sandbox or a guarantee about arbitrary
plugins and child agents. Supply the denial again on resume; omission restores
native tool availability.

| Case | Observed result on both versions |
| --- | --- |
| New name | A native `session/title` event exists before any provider request. |
| Existing title on resume | The original title remains, with no second title event. |
| Unnamed resume | The requested name becomes the first native title. |
| Denied bash | Provider declarations omit bash; a forged bash call produces native `Error: unknown tool "bash"`. |
| Resume denial | Bash remains absent when supplied again and returns when omitted. |
| Same-process sibling | Separate titles persist; only the restricted agent loses bash. |
| Invalid denial | Unknown/reserved names fail before provider inference. |
| Hook conflict | A hook shadowing denied bash and queuing input fails open with zero provider requests; the attempted name does not persist. |

[Selected native frames](selected.json) include title events, provider tool
names and the native tool error. The [manifest](manifest.json) fingerprints
the full local files. Both version runs overlapped, so these file samples are
identified by their execution timestamps rather than assigning a version to
an individual file. Version-specific test logs separately establish seven
passing cases on each installation. Full requests and default prompts remain
local. The final hook-conflict assertions are in the regression, not these
selected files.

## Reproduce

Put the desired DSH installation first on `PATH` and run:

```sh
OAR_TEST=dsh-aimock CI=1 pnpm exec vitest run sea-trial/vendor/dsh-name-tools.vendor.test.ts
OAR_TEST=dsh-aimock CI=1 pnpm run sea-trial
CI=1 pnpm run check
```

The [native regression](../../sea-trial/vendor/dsh-name-tools.vendor.test.ts)
writes full provider and durable-log evidence under `oar-trial-run/`. Unit
controls cover missing services and invalid names on open and resume.

Validation: native cases 7/7 on each version; latest native behavior 18 passed,
1 skipped; full local check 4,437 passed, 599 skipped, plus mock behavior
18 passed, 1 skipped. Skips are unselected native backends and the optional
mock case.

## Review and retained failures

Independent review found a minimum-version lifecycle difference: naming
inside setup ran before the native session was live. Further review moved
naming after every adapter confirmation so a refused open cannot rename a
saved session. It also caught missing early name validation. The final review
found no remaining blockers after both seven-case native reruns.

Earlier logs retain the initial test-fixture errors (the wrong request field
and missing service injection), the minimum-version lifecycle failure, lint
errors and a stale supported-name test inventory. These are separate from the
final passing native results; this was not a clean first attempt.

Native source: [session title service](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/session/session-title/src/index.ts)
and [tool service](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/index.ts).
