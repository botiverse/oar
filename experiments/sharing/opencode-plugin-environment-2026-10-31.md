# OpenCode configured plugin child environment

Runtime version check: 2026-10-31.

**OpenCode 2.2.3 and 2.2.5 are no longer admitted to sharing.** A configured
plugin can launch a child without specifying `cwd`. In the shared process
that child inherits HOME; an isolated session gives it the session directory.
User and project plugins both reproduce the difference. Session options do
not reveal which plugins are configured, so admission cannot safely exclude
only the affected opens. `auto` therefore opens an isolated process and an
explicit `shared` request fails with `UnsupportedOptionError`, option
`placement`. This withdrawal applies to all versions and platforms.

## Observations

On a local Linux x64 host with Node 24.19.0, both exact native binaries ran
against disposable homes and local scripted providers. There were eight
cohorts: two versions, user/project plugin scope, shared/isolated placement.
Each opened two different project directories and completed one real shell
tool in each. Each cohort produced two plugin hooks and two tool executions.

| Native version | Plugin scope | Shared plugin child cwd | Isolated plugin child cwd | Tool cwd | Synthetic environment marker |
| --- | --- | --- | --- | --- | --- |
| 2.2.3 | User | HOME for A and B | Session A/B respectively | Session A/B in both | Matches in every hook child and tool |
| 2.2.3 | Project | HOME for A and B | Session A/B respectively | Session A/B in both | Matches in every hook child and tool |
| 2.2.5 | User | HOME for A and B | Session A/B respectively | Session A/B in both | Matches in every hook child and tool |
| 2.2.5 | Project | HOME for A and B | Session A/B respectively | Session A/B in both | Matches in every hook child and tool |

The plugin's `ctx.location.directory` was the correct project directory in
every case. Its own `process.cwd()` and its actual child cwd were HOME in
shared mode and the project directory in isolated mode. The plugin executes
`node -e` through Node's `execFileSync`, without a `cwd` or `env` option;
the child itself reports `process.cwd()` and `OAR_EXECUTION_ENV_MARKER`.
This does not infer child cwd from a native event or supply the desired cwd
to make the test pass. The plugin does not inspect credentials.

The [native plugin documentation](https://dev.opencode.ai/v2/docs/build/plugins/server/#context)
exposes `ctx.location.directory` as the plugin instance's location. A plugin
can choose it explicitly, but OAR cannot assume existing configured plugins
do so. Checking a fixture that always sets `cwd` would miss this inherited
process-environment difference.

[Selected observations](selected-opencode-plugin-environment-2026-10-31.json)
retain every hook child and tool cwd, plugin location, synthetic marker,
version, platform, placement and probe errors. Temporary directory names
become `session_A`, `session_B` and `process_HOME`. No event payload or
credential is needed for this selection.

## Reproduction and limits

Set `OAR_OPENCODE_BIN` to the exact installed binary, then run:

```sh
pnpm tsx experiments/sharing/opencode-plugin-environment.ts
```

The command retains both cohorts and their comparison for user and project
plugins under `oar-trial-run/opencode-sharing/plugin-environment`. **It exits
nonzero on the observed mismatch**, and missing hook/tool observations also
fail. The manual `opencode-sharing-experiment.yml` workflow retains the same
comparison alongside the candidate behavior/lifecycle controls. Passing
those other controls cannot override this failure. Default CI continues to
exercise public placement refusal, candidate mechanism tests and the real
isolated cleanup regression; native shared controls are manual only.

The selected historical observations can be rebuilt from the retained raw
files, with directory names `opencode-hook-cwd-2.2.3` and
`opencode-hook-cwd-2.2.5`, each containing `user-shared.json`,
`user-isolated.json`, `project-shared.json` and `project-isolated.json`:

```sh
python3 experiments/sharing/select-plugin-environment.py RAW_ROOT
```

These measurements cover Linux x64. No new Windows/macOS child-environment
result is claimed. The earlier three-platform memory, CPU, MCP,
configuration and ownership observations remain valid within their stated
scope, but did not observe this plugin child process. Under
[rule 5](../../docs/design/system.md), hidden configuration with an observed
process-environment difference withdraws the whole version, rather than
assuming the other platforms are safe. The marker tests inheritance of one
synthetic variable, not equality of every possible native environment key.
The plugin hook is an actual native callback; it is not an OAR-hosted tool.

The disabled adapter's exact-version checks, canonical-directory lifetime
restriction, routing and cleanup remain available to explicit experimental
composition. No package export or environment variable bypasses production
admission. Re-admission requires new evidence and review.
