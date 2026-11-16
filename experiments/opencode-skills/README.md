# OpenCode independent skill discovery

2026-11-16, Linux x64. Native binaries: OpenCode 1.19.5, 2.2.7 and 2.3.0.
All probes use isolated HOME/XDG directories and synthetic skill files, without
an account or model request. The host can obtain the native catalog without
opening an OAR session; the OpenCode adapter owns projection and cleanup.

## Results

OpenCode v1 `debug skill` returns the native catalog, including the builtin
`customize-opencode` and all six fixture skills. Locations preserve their
actual directories, including shared `.claude/skills` and `.agents/skills`
directories at user and project scopes, project `.opencode/skills` and
XDG `opencode/skills`. OAR does not relabel these as OpenCode-owned directories.

On 2.3.0 a cold `api skill.list --standalone` exits successfully with `data: []`.
In a single private server the first skill query was empty at 0.54 seconds;
the provider query finished at 1.46 seconds and the subsequent skill query
returned three bundled skills plus the six fixtures. An empty initial catalog
therefore does not establish that no skills exist.

The adapter starts its own password-protected loopback server, awaits the
native provider query, reads plugin states, then reads skills. Both 2.2.7 and
2.3.0 passed the six-directory fixture and success/failure/timeout cleanup
controls. A real plugin that throws during activation also returned the catalog
with `partial:true` and completed cleanup on both versions. The v1 success control passed; its HTTP-specific controls are skipped.
Each result retains metadata only. No skill bodies, provider details or raw
plugin errors reach the caller. Native paths are retained; v1's `<built-in>`
marker becomes `source: "builtin"`. V2 exposes no origin field, so OAR retains
its path (including `skill://` URIs) without inventing one.

Native catalog parsing skips the malformed frontmatter fixture. A successful
catalog is complete as a native catalog, not an audit of every file on disk.
V2 failed plugin states produce `partial:true`; malformed HTTP payloads or
activation failures produce `unavailable`, not empty success. An empty catalog
is accepted only after activation settles. V1 exposes no plugin diagnostics.

## Readiness evidence

At both [v2.2.7](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/server/src/handlers/provider.ts)
and [v2.3.0](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/server/src/handlers/provider.ts),
`provider.list` explicitly awaits `awaitPlugins` before returning.
[The v2.3.0 barrier](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/server/src/location.ts)
waits for `Plugin.awaitActivation` and fails after five seconds; OAR adds its
own caller deadline and cleans up on every outcome. No retry or nonempty-list
heuristic substitutes for this barrier. An empty provider list can still prove
that activation settled.

The [skill route](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/protocol/src/groups/skill.ts)
has only location parameters, with no readiness option.
[`plugin.list`](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/plugin.ts)
returns a current snapshot; `plugin.updated` and `skill.updated` announce changes,
not global completion. No independent public activation-ready query was found.
The adapter requires v2.2.7 or newer for this verified sequence; this is a skill
reader requirement, not a floor on every OpenCode operation.

The same race is tracked by [#51680](https://github.com/anomalyco/opencode/issues/51680),
closed by [#62569](https://github.com/anomalyco/opencode/pull/62569).
The tested published binary and tag still exhibit it. The
[unposted follow-up draft](upstream-comment-draft.md) asks which release carries
the fix rather than opening a duplicate issue.

## Reproduce

```sh
python3 experiments/opencode-skills/probe.py /absolute/path/to/opencode
OAR_TEST=opencode-skills OAR_OPENCODE_BIN=/absolute/path/to/opencode \
  pnpm vitest run sea-trial/vendor/opencode-skills.vendor.test.ts
```

The Python probe targets v2 on Linux and leaves its isolated fixture directory
for inspection. The vendor suite removes fixtures and retains selected public
results under `oar-trial-run/opencode-skills`. CI runs the native cases alongside
the existing v2.2.7 cleanup job and the v1.19.5 vendor job.

[Selected evidence](selected.json) contains only metadata and normalized fixture
paths. Full local raw probes, test logs and original setup failures remain with
the author; [manifest](manifest.json) records their digests. An initial v1 run
against the v2-created database failed before querying; it was corrected to a
separate isolated HOME and is not classified as an adapter defect.

Native startup can execute configured plugins, access configured remote skill
sources and write its own logs, cache or database. OAR changes no user skill
files or config and creates no persistent service registration. These are
independent discovery results, not an existing session's live skill state.
