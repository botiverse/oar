# Antigravity file skill discovery

The file reader is enabled only on Linux and macOS. Windows retains the
existing native query until its directory-link behavior is verified.

On Linux x64, the final isolated controls on CLI 1.5.10 and 1.5.11 returned
partial inventories of 6, 15, 23, 26, 27 and 30 entries across six stages.
Every returned entry matches native `/skills`, including complete metadata,
paths and ordering. The uncertain `native_swarm` builtin is omitted; all other
native entries must match on each of three file reads per stage. No model
requests were submitted. The selected native frames, OAR results and timings
are [1.5.10.json](1.5.10.json) and [1.5.11.json](1.5.11.json).

| CLI | File reads | Median | Maximum | Native global MCP child | File reader MCP child |
| --- | ---: | ---: | ---: | --- | --- |
| 1.5.10 | 18 | 35.4 ms | 68.5 ms | started | absent |
| 1.5.11 | 18 | 29.5 ms | 83.4 ms | started | absent |

These are local observations with small synthetic fixtures, not a latency
bound for large or remote filesystems. `installation()` is outside the timed
read; callers supply its versioned snapshot.

## Native rules represented by the controls

- Workspace discovery uses `.agent`, `.agents`, `_agent`, `_agents`, with
  repository-root entries winning over the current directory. Without a
  repository, only the requested directory is searched. Global discovery uses
  `.gemini/antigravity-cli`, `.gemini/config`, then `.gemini`.
- POSIX native working directories resolve links before repository discovery.
  Manifest containment compares resolved targets but preserves the declared path in
  returned metadata. A link into the repository is accepted; a link out is
  omitted. Direct discovery follows linked skill directories and preserves
  their path. Global and builtin paths retain the supplied HOME spelling.
- Direct workspace skills precede workspace declarations; global direct skills
  follow them. Global declarations precede builtin mounts. A hidden winner
  shadows lower-priority duplicates before being omitted.
- Workspace manifest paths resolve at the declaring directory, with repository
  root fallback, and outside-repository entries are omitted. Global relative
  paths resolve below `.gemini/config`. Native startup migrates old CLI
  manifests into that directory; the reader selects their source without
  writing it. `include_only` and `exclude` use literal relative names in these
  measured versions; an explicit nested path can select a deeper skill.
- YAML scalar text keeps its spelling, including `1.0` and dates. Quoted
  booleans in invocation flags, malformed YAML and structured names are
  omitted. Missing names use the containing directory. Multiline descriptions,
  flow-mapping boolean flags, manual-only entries and hidden entries follow native metadata.
- Plugin namespaces use directory identity while the reported plugin field
  uses manifest name. Byte-identical skill files are deduplicated before
  namespacing; changing the body or frontmatter preserves a distinct file.
  Malformed plugin manifests are omitted. Global enable overrides and manifest-disabled plugins
  are supported. Scanning is one directory level deep.
- Six verified builtin mounts are read from extracted `SKILL.md` files, not
  from every builtin directory. Before native initialization, the file reader
  returned an empty partial inventory and created nothing. Signed-out reads
  remained available. All file inventories are partial because the conditional
  `native_swarm` mount is not yet verified. This does not claim the catalog is
  a live model context.

These observations take precedence over broader wording in the bundled
customization guide. In particular, a global manifest's `run-workflow`
replacement won over the builtin in both selected controls.

## MCP startup and an unresolved sample

The probe configures only a synthetic local JSON-RPC server that writes a
start marker. In the selected Linux samples, native `/skills` started the globally
configured child on both versions; the workspace-only marker remained absent. The file reader never
started either marker. No Raft configuration, token or real account was used.

A later [macOS 1.5.11 run](https://github.com/botiverse/oar/actions/runs/44341885946/job/134948035070)
finished native `/skills` successfully with the global marker absent. Its
[retained artifact](https://github.com/botiverse/oar/actions/runs/44341885946/artifacts/14445909351)
does not establish whether native skipped the child or exited before the child
wrote the marker. The [selected assertion and corrected Linux control](mcp-marker-control.json)
retain that boundary and the new detector result. Native startup is therefore recorded in both scopes, not
required as a detector control. The probe validates the detector by running the
same marker script directly once; only after writing its marker does that
control exit instead of serving JSON-RPC. Both file-reader scopes still require
`fileStarted === false`. Each scope rewrites its MCP configuration to a separate
file-reader marker before that phase, so a late native child cannot mark the
file-reader's path. The native marker is observed again after the file read.
Marker observations are retained even if the negative assertion fails. A
deterministic synthetic control writes the native marker during the file phase
and verifies that it passes; writing the file marker instead still fails and
retains that observation. No wait, retry or product behavior changed.

The first local omission and a later Linux CI failure both reported six native
builtins, omitting `swarm`, while its materialized file was readable. The CI
failure also retained `plugins.swarm.enabled: true` in the saved configuration.
The [initial assertion log](initial-omission.log) and
[CI native/config/OAR evidence](swarm-omission-ci.json) retain both failures.
Earlier controls included `swarm` in 48 repeated starts and 48 fresh-home
starts. A later configuration control used 64 isolated homes, each with two
starts, across both versions and absent, empty, true and false plugin settings.
Two 1.5.11 second starts omitted `swarm` with the same saved false setting that
included it in the other samples. A dependable mount rule remains unknown;
no setting is treated as proof that the builtin is offered.

The reader therefore omits the automatic `native_swarm` mount and always
returns `partial: true`. A separately discovered local skill named `swarm`
remains visible. The comparison permits only that exact builtin path to be
missing, requires the partial flag, and keeps full equality for all other
entries. It does not retry a mismatch. Restore the builtin only after its
native mount rule is verified. Full raw controls remain local.

## macOS path regression

The first macOS CI comparison failed at the roots stage: native returned six
workspace paths below `/private/var/...`, while OAR returned `/var/...`.
Global and builtin paths matched. The [selected differences](macos-path-failure.json)
retain that failed result. Linux symlink fixtures on both verified versions
reproduced the physical working-directory behavior and confirmed the manifest
and linked-directory rules above. The file reader now applies those rules;
full path equality remains part of every comparison.

The next Windows run found the inverse short-name mismatch: native retained
`RUNNER~1` while Node's native realpath returned `runneradmin`. The
[selected differences](windows-path-failure.json) preserve all six mismatched
workspace paths. Preserving that spelling passed the first five stages, but
the junction-cwd stage still failed: native returned 14 entries and the file
reader returned 27, including workspace entries native omitted. The
[selected junction sample](windows-junction-failure.json) preserves the full
native and OAR inventories for that stage. The Windows discovery rule is
unresolved, so the file reader is disabled there. Windows retains the guarded
native query; CI verifies its metadata, builtin initialization and signed-out
refusal. The full differential comparison remains the requirement for enabling
Windows in a follow-up. Linux and macOS passed at head `52fed5d2`.

The standalone Node comparison also caught an invalid named import from the
CommonJS YAML package that Vitest's transformation had hidden. The reader uses
the package's default export, and the CI vendor case launches the comparison
through Node's module loader so this boundary is tested as well.

## Reproduce

Use an existing isolated installation of 1.5.10 or 1.5.11; the script does not
upgrade the selected executable:

```sh
OAR_ANTIGRAVITY_BIN=/path/to/agy pnpm tsx experiments/antigravity-file-skills/probe.ts /tmp/agy-file-skills.json
```

The probe uses a temporary HOME, a local scripted provider and blocked external
proxies. It preserves the comparison before cleaning the fixture. The vendor
case runs the same probe:

```sh
OAR_ANTIGRAVITY_BIN=/path/to/agy OAR_TEST=antigravity-file-skills pnpm vitest run sea-trial/vendor/antigravity-file-skills.vendor.test.ts
```

CI installs the separately frozen 1.5.11 archives and runs this comparison on
Linux and macOS. On Windows it verifies that the same pinned version still
uses the native query. The existing 1.5.0 ACP baseline is unchanged.
