# Antigravity file skill discovery

On Linux x64, the final isolated controls on CLI 1.5.10 and 1.5.11 matched
native `/skills` at all five stages: 7, 16, 24, 27 and 28 entries. Each stage
compared the complete metadata and ordering on three file reads. No model
requests were submitted. The selected native frames, OAR results and timings
are [1.5.10.json](1.5.10.json) and [1.5.11.json](1.5.11.json).

| CLI | File reads | Median | Maximum | Native global MCP child | File reader MCP child |
| --- | ---: | ---: | ---: | --- | --- |
| 1.5.10 | 15 | 12.8 ms | 23.3 ms | started | absent |
| 1.5.11 | 15 | 12.5 ms | 43.9 ms | started | absent |

These are local observations with small synthetic fixtures, not a latency
bound for large or remote filesystems. `installation()` is outside the timed
read; callers supply its versioned snapshot.

## Native rules represented by the controls

- Workspace discovery uses `.agent`, `.agents`, `_agent`, `_agents`, with
  repository-root entries winning over the current directory. Without a
  repository, only the requested directory is searched. Global discovery uses
  `.gemini/antigravity-cli`, `.gemini/config`, then `.gemini`.
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
- Seven native builtin mounts are read from extracted `SKILL.md` files, not
  from every builtin directory. Before native initialization, the file reader
  returned an empty partial inventory and created nothing. Signed-out reads
  remained available. This does not claim the catalog is a live model context.

These observations take precedence over broader wording in the bundled
customization guide. In particular, a global manifest's `run-workflow`
replacement won over the builtin in both selected controls.

## MCP startup and an unresolved sample

The probe configures only a synthetic local JSON-RPC server that writes a
start marker. Native `/skills` started the globally configured child on both
versions; the workspace-only marker remained absent. The file reader never
started either marker. No Raft configuration, token or real account was used.

One early fresh-home 1.5.11 comparison reported six native builtins, omitting
`swarm`, while its materialized file was readable. The next fresh comparison
and the completed controls included it. Follow-up native controls included
`swarm` in all 48 repeated starts and all 48 fresh-home starts across the two
versions. The cause of that one omission remains unknown; later successes do
not explain it. The [initial assertion log](initial-omission.log) is retained; the complete
raw material remains local. CI compares the complete native result without retries or removing
`swarm` from either side.

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
Linux, macOS and Windows. The existing 1.5.0 ACP baseline is unchanged.
