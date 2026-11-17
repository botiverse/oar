# Cursor SDK skill discovery

SDK: `@cursor/sdk` **1.4.0**, Linux x64, 2026-11-17. Cursor's public SDK
exports no independent skills query. Its internal loader is compiled into
`dist/esm/993.js`, without an importable loader export. OAR does not patch
or load that bundle to answer `skills()`.

After [the default configuration fix](../cursor-user-configuration/README.md),
OAR sessions select `project` and `user`. The new reader discovers metadata
from those sources with `view: "discovered"`; it does not describe a running
session or a session opened with `userConfiguration: "exclude"`.

## Source and measured mapping

The SDK bundle's `nf`/`ff`/`mf` define five local compatibility roots:
`.cursor/skills`, `.claude/skills`, `.codex/skills`, `.grok/skills` and
`.agents/skills`, under both the workspace and home. `im.computeFoldersToWatch`
also includes workspace `.cursor/rules` when it contains `SKILL.md` files.
`Ef` walks each direct root to depth 10, skips hidden directories,
`node_modules`, `__pycache__`, `dist` and `build`, and deduplicates real paths.
`af` excludes hidden components below skill roots and six special Codex
skill names, including `imagegen` and `openai-docs`.

`_f.discover` additionally scans nested directories inside a Git workspace,
except home itself and protected macOS ancestor directories. OAR invokes
Cursor's own ripgrep companion with the measured `aa`/`Ia` flags and
exclusions, so native ignore-file behavior remains in that executable.
The configured `CURSOR_RIPGREP_PATH` takes precedence. If it cannot be
resolved, nested discovery is incomplete and `partial` is true.

`cN` selects user/project roots and `lN` filters canonical paths; targets
outside both roots and the unselected home `.cursor/skills-cursor` managed
root are excluded. `Hf` excludes skills whose `metadata.surfaces` excludes
`sdk`. `Zf` treats `alwaysApply: true` as a rule, not a skill. `Tf`/`Rf`
keep the first identical relative skill path across compatibility directories.
Malformed duplicates also retain first-entry precedence.

Names come from the containing directory, as in the native skill's display
name; frontmatter `name` mismatches are native warnings. Description truncation
matches the SDK's 1536 UTF-16-unit boundary without splitting a surrogate pair.
`disable-model-invocation` is preserved. Body, raw frontmatter and parser errors
are never returned. OAR uses the same gray-matter 4.0.3 parser family and rejects
JavaScript frontmatter engines, as the SDK does. Malformed metadata, missing
required descriptions, non-UTF-8/binary input and read failures make the result
partial. The SDK can decode additional encodings; OAR deliberately does not
claim those entries from a UTF-8 scan.

`source: user`/`workspace` and `scope: user`/`project` identify the measured
loading root. No enabled state or plugin identity is invented. Team/MDM,
managed synchronization and plugin sources are not selected by OAR sessions.
The reader does not load hooks, MCP configuration or the SDK, change files,
create an agent, authenticate or request inference. Git and ripgrep are the
only executables used, and receive the reader's environment with a deadline.

## Drift check

Run the native comparison without an account:

```sh
OAR_TEST=cursor-skills CI=1 pnpm vitest run sea-trial/vendor/cursor-skills.vendor.test.ts
```

The two cases use sibling home/workspace fixtures, with and without a Git
repository. Both compare all valid native entries' names, canonical paths,
descriptions and invocation flags with the public OAR reader. Invalid native
entries must produce `partial:true`. Fixtures include all ten roots, nested
and ignored paths, hidden paths, rule-only entries, SDK/IDE filtering,
duplicate brands, malformed duplicates, symlink aliases, external symlink
targets, depth limits and surrogate-boundary descriptions.

The test canonicalizes the SDK and temporary-copy paths, copies that SDK
and adds one read-only observer at the existing merged-loader result.
A test-only Node module-resolution hook resolves the copy's external package
imports from the original SDK entry, preserving Node's import conditions,
subpaths and the installed dependency graph. Relative imports still load
the copy. No package-manager directory layout or cross-volume junction is
assumed. No discovery/filter/parser logic is replaced;
the installed SDK stays unchanged. The public `prewarmLocalWorkspace` drives
the real loader. The observer's exact anchor must occur once, otherwise the
test fails before querying. The pinned SDK version and bundle fingerprint
are recorded. A version update must remeasure the loader and fixtures, not
blindly change this anchor. The observer is test-only and is not a supported
product interface.

All socket connections and fetch calls in the isolated child are blocked.
The SDK attempts background connections, counted in the retained report;
none is admitted. There is no real login, model prompt or inference.
CI runs the native comparison on Linux, macOS and Windows and retains its
output even on failure. Only Linux has been run locally for this report;
other-platform success depends on those CI results.

Selected metadata and raw fingerprints are in [evidence.json](evidence.json).
Full local evidence remains under `artifacts/cursor-skills/` and the owned
worktree's `oar-trial-run/cursor-skills/`.

## Windows test bootstrap correction

The first Windows run at `8ab53f8f` passed the unit suite and build, but both
native comparisons stopped while importing the copied SDK, before skill
loading: `ERR_MODULE_NOT_FOUND` for `@bufbuild/protobuf`
([job 133758056224](https://github.com/botiverse/oar/actions/runs/43998995413/job/133758056224)).
Canonicalizing the entry fixed a preserved-link Linux control, but the same
Windows import failure remained at `b8014a81`
([job 133766669278](https://github.com/botiverse/oar/actions/runs/44001569277/job/133766669278)).
That run passed the Windows unit suite and build; Linux and macOS checks
passed. The original failing dependency layout was not retained, so its
precise Windows cause is unconfirmed.

The observer no longer guesses a dependency directory or links it into the
copy. Its external imports now use the original SDK's resolution context.
A synthetic fixture with dependencies nested inside the SDK reproduced the
old strategy's missing-package failure; the replacement passed that layout
and sibling dependencies. These controls also verify import-versus-require
conditions, package subpaths, transitive dependencies and unchanged local
observer modules. They establish the removed layout assumption, not the
unrecorded Windows root cause. Both real SDK comparisons pass locally with
preserved links and the replacement. Windows verification remains a new-CI
requirement. Product discovery is unchanged.
