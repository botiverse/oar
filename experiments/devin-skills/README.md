# Devin native skill catalog

On November 17, 2026, Devin **3000.12.57 (96542e930752)** on Linux x64
returned three built-in skills without an account or prompt. With eight
synthetic user/project skills installed, `skills list --json` and OAR's public
reader returned matching metadata. The reader now exposes that native catalog.

## Reproduce

Select the official 3000.12.57 executable explicitly, then run:

```sh
OAR_TEST=devin-skills OAR_DEVIN_BIN=/absolute/path/to/devin \
  pnpm exec vitest run sea-trial/vendor/devin-skills.vendor.test.ts
```

The [vendor case](../../sea-trial/vendor/devin-skills.vendor.test.ts) creates
sibling temporary HOME and project directories, supplies no account variables,
and points HTTP proxies at a closed loopback port. It preserves the native
catalog and public result under `oar-trial-run/devin-skills/result.json`, then
removes only its own fixture. No model provider or real login is used. This
case is opt-in; required CI runs the adapter's synthetic regressions. Native
macOS and Windows skill discovery have not been measured by this study.

The executable came from the official
[current manifest](https://static.devin.ai/cli/current/manifest.json), selecting
[the versioned Linux x64 archive](https://static.devin.ai/cli/3000.12.57/devin-3000.12.57-x86_64-unknown-linux.tar.gz).
Its SHA-256 was checked before extraction:
`0946784ef886d716e82a8026f76933bf0a6e4f0a804a23722bb62047e8c07d4a`.

## Observations

The selected [catalog evidence](catalog-linux.json) retains only metadata and
fixture-relative paths, never skill bodies, logs, account data or identifier
values. The [raw manifest](raw-manifest.json) fingerprints local source material.

| Control | Native result |
| --- | --- |
| Empty HOME | `devin-cli`, `declarative-repo-setup`, `upload-secrets`, all `provider: Builtin` |
| User fixtures | XDG config `devin/skills`, home `.agents/skills`, `.claude/skills`, `.codeium/windsurf/skills` |
| Project fixtures | `.devin/skills`, `.agents/skills`, `.claude/skills`, `.windsurf/skills` |
| Malformed YAML | Omitted entirely; the other entries still have empty `warnings` and `errors` |
| Public reader | All eleven entries' names, descriptions, paths, sources and invocation flags match the native JSON |
| Native state | Existing config unchanged; no session database or credential file; installation identifier, telemetry state, logs and plugin lock files created |
| Skill body sentinel | Not returned and its embedded shell command was not executed |

These are observed native roots, not an OAR scanner or an exhaustive list of
Devin's import options. The official [skill overview](https://docs.devin.ai/cli/extensibility/skills/overview)
and [format reference](https://docs.devin.ai/cli/extensibility/skills/creating-skills)
describe additional configurable imports and trigger metadata. OAR delegates
selection, precedence and parsing to the native command.

`provider` identifies a brand: `Devin`, `Claude` and `Windsurf` each cover both
user and project fixtures. Only `Builtin` becomes a shared scope. Non-empty
`base_dir` remains a directory path; OAR does not invent a file path. The native
`triggers` array decides whether model invocation is disabled. No native plugin
identity was observed, so that field remains absent.

The per-row diagnostic arrays cannot reveal malformed files omitted before
rows are emitted. OAR sets `partial: true` only when a returned row has native
`errors`; warnings alone do not. Silently rejected files are also absent from
the native runtime's loaded catalog. `partial: false` describes that catalog,
not a promise that every file on disk is valid. Invalid JSON, malformed rows, nonzero process exit and
timeout are query failures. Tests also cover empty catalogs, diagnostic text
redaction, invalid deadlines and waiting for process termination after timeout.

## Network and orientation costs

An initial isolated native query traced with `strace -f -e trace=network`
attempted feature-flag and telemetry connections: DNS for `unleash.codeium.com`
and a Sentry ingest host, plus outgoing TCP port 443. A second query with
`HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` set to `http://127.0.0.1:9` and an empty
`NO_PROXY` reached only that loopback TCP endpoint and returned the same catalog.
[Selected connection observations](network-linux.json) distinguish attempted
connections from any claim about remote acceptance or the transmitted payload.

No telemetry/feature-flag disabling switch was found in this executable's
`--help`, `skills --help`, `skills list --help`, or the official
[configuration](https://docs.devin.ai/cli/reference/configuration/config-file),
[commands](https://docs.devin.ai/cli/reference/commands) and
[enterprise controls](https://docs.devin.ai/cli/enterprise/controls) references.
Binary inspection found `disable_telemetry` among user/team status fields, not
a verified environment option. No guessed switch is used. The blocking proxy
belongs only to the fixture; the product preserves the host's environment and
native configuration, including its network policy.

Default `orient()` depths do not call inventory readers. Explicit
`include: ["customization"]` can call them at any depth and already permits
native process, configuration and network side effects. `localOnly` is an auth
reader declaration, not an inventory property. This query is not added to the
default local path. Its brand source labels do not establish user-owned
customization counts. See the [orientation contract](../../docs/spec/orientation.md#optional-customization-counts).

## Pi RPC consistency check

Pi 1.5.2's published `dist/modes/rpc/rpc-mode.js`, `get_commands` handler,
enumerates `extensionRunner.getRegisteredCommands()`, `promptTemplates` and
`resourceLoader.getSkills().skills` without pagination, filtering or truncation.
Its response lacks some metadata and loading diagnostics, but the loaded
catalog itself is complete. The previous OAR rule always returned partial
because diagnostics were absent. That is corrected to `partial: false` for a
successful native response; query errors still fail the reader.

The existing [native reader cases](../../sea-trial/vendor/pi-rpc-readers.vendor.test.ts)
now include a malformed skill beside a valid one. Both bundled-entry and
explicit-command paths on Linux Pi 1.5.2 returned the valid skill, extension
command and prompt template; the malformed skill was omitted. Both processes
used the fixture environment and exited without persistent sessions. This
checks the same distinction between rejected files and an incomplete catalog.
