# OpenCode independent skill discovery

2026-11-16, Linux x64. Native binaries: OpenCode 1.19.5, 2.2.7 and 2.3.0.
All probes use isolated HOME/XDG directories and synthetic skill files, without
an account or model request. The host can obtain the native catalog without
opening an OAR session; the OpenCode adapter owns projection and cleanup.

The [2.4.1 comparison](activation-2.4.1.md) records the change to cold catalog reads and the limits of polling for plugin startup.

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
marker becomes `source: "builtin"` with no `path`. V2 exposes no origin field, so OAR retains
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
The skill reader uses this sequence from v2.2.7 through the 2.3.x line.
[The 2.4.0 change and reopen condition](activation-2.4.1.md#what-a-one-shot-reader-can-report) explain the upper bound.

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

## Windows path spelling control

The first PR #849 Windows run (43908361885, job 133443219205) returned all
six fixtures, but two assertions failed because home skills used the long
`runneradmin` path while the fixture used the equivalent `RUNNER~1` spelling.
The reader preserves that native string. The vendor test now compares native
and fixture paths through filesystem `realpath`, keeping identity assertions
and all cleanup checks. This is a test correction, not a native retry or a
change to returned paths. The original failed run remains visible in CI.

## V1 stdout drain

On November 18, 2026, three pipe/file pairs on each isolated Linux x64 install
reproduced successful native exits with incomplete piped JSON. One synthetic
user skill with a 512 KiB body was sufficient in an empty working directory.
Every sample exited 0 with zero stderr bytes.

| Version | Pipe bytes, invalid JSON | File bytes, valid JSON | Samples per capture |
| --- | ---: | ---: | ---: |
| 1.18.30 | 65,536 | 541,936 | 3 |
| 1.19.5 | 131,072 | 541,936 | 3 |

The v1 reader now supplies an open regular file as stdout, waits for native
completion, then parses the file. The file and its private directory are
removed on success, failure and timeout. Native failure reasons retain a
bounded, redacted first stderr line and exit status. Invalid or empty output
is reported without exposing catalog contents.

The [standalone reproduction](v1-stdout.py) reports only sizes and status:

```sh
python3 experiments/opencode-skills/v1-stdout.py /absolute/path/to/opencode
```

[Selected results](stdout-selected.json) also record successful OAR discovery
on both v1 versions with over 64 KiB of projected metadata. The v2.2.7 HTTP
reader returned the same six fixture skills in a catalog over 64 KiB; success,
transport failure, deadline and plugin-failure controls all reclaimed the
owned process and port. The change does not alter that HTTP reader.

Upstream [#64635](https://github.com/anomalyco/opencode/issues/64635) retains
these versioned controls and references the earlier stale-closed
[#26399](https://github.com/anomalyco/opencode/issues/26399). Remove the v1 file
capture at the first published v1 release where repeated pipe/file comparisons
match and return valid JSON on the supported systems, once that release is the
supported version floor.
An issue closure or a small-catalog success alone does not establish that
large stdout writes drain before exit.

## Exact-version builtin provenance

November 18, 2026, isolated Linux x64 controls reproduced a mismatch between
OAR's documented version boundary and its implementation. Before the fix,
OpenCode 2.3.2 received `scope: "builtin"` for the `opencode` and `report`
skill URIs because classification checked only the major version.

The reader now passes its already-resolved full release identifier to the
classifier. Only stable 2.2.7 and 2.3.0 can receive builtin scope for
`skill://opencode/SKILL.md` and `skill://report/SKILL.md`. Other releases,
prereleases and custom builds retain the URI with unknown scope. This adds no
version process. Existing numeric release comparisons keep their behavior.

[Selected before/after results](scope-selected.json) retain exact package
identities and metadata. Native 2.2.7 and 2.3.0 preserve the verified mapping;
2.3.2 preserves both URI strings without scope. Seeing those spellings on
2.3.2 does not verify their registration ownership, so this control does not
extend the allowlist. The separate `skill://browser/SKILL.md` identity stays
unknown on all three v2 releases. All six filesystem fixtures retain their
user/project scope and native paths. V1 1.19.5 still maps its explicit
`<built-in>` marker to `source: "builtin"` and `scope: "builtin"`, omitting
`path`.

Run the vendor command above with each exact binary. V1's success control
passes; all three v2 versions pass success, transport failure, deadline and
plugin-failure controls, including process and port cleanup. Public-reader
unit controls also cover newer versions, suffixed builds, a noncanonical
numeric spelling and version detection when installation metadata is absent.

## Windows timeout and listener ownership

On Windows x64, OpenCode 2.2.7 owned the skills listener directly in all five
rounds. At startup and at the query deadline, the listener PID and creation
time matched the `opencode.exe` OAR spawned. The first two rounds ran with
the ordinary native cleanup suite. The other three ran the timeout case alone.

One round reproduced the failing assertion. At 511 ms after the deadline the
launcher PID was already absent, but a connection from local port 62633 to
the announced port 62564 succeeded. The subsequent TCP table showed no
listener. At 982 ms, after OAR's joined cleanup, the same port refused a
connection. All five ports refused at joined cleanup. No sample identified a
different listener. The owner at the precise instant of that successful
connection was not sampled.

The vendor test retains the TCP observation at root exit, then checks the
port once when the owned child's `exited` promise resolves. A control keeps
a real loopback listener open across a child's exit and verifies the same
assertion fails. Neither assertion retries a connection.
[Five-round Windows measurement](https://github.com/botiverse/oar/actions/runs/44573473058)
and [selected observations](windows-timeout.json).
