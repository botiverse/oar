# CodeBuddy skill catalog boundaries

CodeBuddy 2.184.0, Linux x64, 2026-11-17. `codebuddyRuntime.skills()` remains
unsupported. The tested executable interfaces do not expose the complete
skill catalog, and a single exported library call does not match the native
CLI's built-in entries. OAR does not reconstruct the CLI's filesystem,
product configuration or loading rules to fill this gap.

## Results

The [selected result](result.json) comes from one isolated HOME with five
synthetic skill files and no real login. The local provider records attempts
and returns a deliberate HTTP 400; no model generates an answer. A real standalone CodeBuddy
ACP process creates a session and lists marker skills in its native
`available_commands_update` notification. No provider requests were observed
during initialization or the exported library read. Headless `/skills` then
attempted one request, which the local provider rejected.

| Surface | Observed answer | Boundary |
| --- | --- | --- |
| `--help` | No standalone skill-catalog command | `/skills` is a slash command, not a CLI subcommand. |
| stream-json `initialize` | Command descriptors, no marker skills | This answer cannot stand in for a skill catalog. |
| ACP `session/new` | User/project markers, manual-only marker, built-in entries | The marker with `user-invocable: false` is absent. This is a command-completion list. |
| `--print /skills --output-format json` | Attempts the configured model provider, then exits 0 with empty stdout after its refusal | This is not an offline structured catalog query. |
| npm `/server` export `readSessionCatalog({cwd, fs})` | User/project markers, hidden and manual-only markers, built-in `loop` | The standalone CLI also reports built-in `__PLUGIN_NAME__-review`, which this answer lacks. |

The hidden marker's omission from ACP is intentional: the installed
`projectAcpAvailableCommands` interface takes already-filtered visible skills.
The library catalog includes that marker, so treating the ACP command list as
all skills would discard a skill the native loader knows about. The `.claude`
marker appears in neither answer; this experiment does not claim it is a
CodeBuddy loading root.

The library test loads the installed npm package's exported `server.mjs` in a
separate Node process. It supplies the real filesystem through the package's
own `OverlayFs({root: "/", mountPoint: "/"})` and the same cwd. It does not
supply product configuration, skill roots, setting-source overrides or a
custom plugin loader. Even this call differs from the executable's built-in
catalog. An earlier exploratory call without `fs` used the library's default
memory filesystem and did not see the disk fixtures; that result is not a
CodeBuddy bug.

The standalone installation has an executable, not this npm library export.
OAR must not load another installation's package to answer for the selected
executable. The npm library is therefore not admitted as a universal
executable reader, and no vendor code is imported into the OAR host process.
A future implementation needs an executable-owned catalog query, or a single
exported query whose completeness and selected-installation identity are
verified. This is a measured gap in the checked surfaces, not a claim that no
other interface can ever exist.

## Reproduce

Use a disposable Linux installation of the standalone binary and the npm
package at the same version. The probe uses the supplied Node executable for
the library child; it never runs that library in the host process.

```sh
python3 experiments/codebuddy-skills/probe.py \
  --binary /path/to/codebuddy-2.184.0 \
  --server /path/to/codebuddy-code/server.mjs \
  --node node \
  --out /tmp/codebuddy-catalog-evidence
```

The probe creates and removes its own temporary HOME, stops both protocol
process groups, bounds each process, and leaves raw output in `--out`.
`result.json` retains only selected skill metadata and raw-file fingerprints;
raw output is not committed. No skill body is returned in the selected
result. This is a discovery experiment, not a no-network guarantee or a
cross-platform qualification. Native startup may create local state inside
the disposable HOME. It does not establish plugin parity, all loading roots,
or how a real account's configuration affects the catalog.

## Sources

- [Official skills documentation](https://www.codebuddy.ai/docs/cli/skills)
  describes native skill loading and invocation controls.
- [CLI reference](https://www.codebuddy.ai/docs/cli/reference) and the tested
  binary's `--help` describe the process entry points.
- Installed 2.184.0 package exports `./server`; its
  `dist-server/types/node/server/read-session-catalog.d.ts` describes a catalog
  read without admitting a query or persisting a session.
- Installed `dist-server/types/node/server/formats/acp/acp-available-command.d.ts`
  documents projection of already-filtered visible skills.
