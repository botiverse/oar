# Independent runtime inventories

OAR exposes four independent inventory readers on every runtime:

```ts
const runtime = defaultRuntimes.require("codex");
const installation = await runtime.installation?.();
if (installation?.kind === "available") {
  const skills = await runtime.skills(installation, { cwd: "/my/project" });
  const commands = await runtime.commands(installation, { cwd: "/my/project" });
  const servers = await runtime.mcpServers(installation, { cwd: "/my/project" });
  const tools = await runtime.tools(installation, { cwd: "/my/project" });
}
```

The options object is optional. `cwd` defaults to `process.cwd()` and is resolved
to an absolute path; a host should pass its project directory. `timeoutMs`
defaults to 15 seconds and must be positive and finite. `env` applies the
[reader environment overlay](orientation.md#environment) to native processes.
Pi's in-process inventories pass it to the temporary session's Bash tool;
SDK configuration, credentials and extension loading use the host environment.
With `execution: "subprocess"`, skills and commands use that host SDK path
when the overlay makes no actual change. Otherwise they use a bounded native
RPC process with the same full environment and startup policy as a session,
plus `--no-session`. Tools still use the host SDK and reject actual environment
changes before loading it. Omission, unchanged values and removal of absent
variables keep the SDK path and its richer metadata and loading diagnostics.
See [Pi reader environments](../runtimes/pi.md#reader-environment).

Cursor uses measured local discovery where its SDK exposes no independent query.

These operations discover native information independently of existing agents.
There are **no Session inventory methods, session IDs, or session query mode**.
A fresh process's connections or active defaults do not describe an existing
agent. No model prompt is submitted, but the runtime starts in `cwd` the way
it would for a session: it can load and run that workspace's code (pi's
project extensions, a configured stdio MCP server) and connect configured
MCP servers. Do not take an inventory of a directory you do not trust; this
holds for every reader. Pi uses a temporary in-memory SDK session or native
RPC process with `--no-session`, without writing trust configuration, and
disposes it after discovery.
Inventory results never enter a session's record stream. Servers a session
was given in `SessionOptions.mcpServers` are that session's, not the
runtime's configuration, so `mcpServers()` never lists them.

## Results

`InventoryResult<T>` is a discriminated union:

* `ok`: `items`, absolute directory in `scope.cwd`, `observedAt`, `view` and
  `partial`. An empty list is a successful native empty result.
* `unsupported`: stable `code` and explanatory `reason`. The codes are
  `native_query_unavailable` (no native query), `transport_unavailable`
  (the default supplied by `defineRuntime`), `scope_unavailable` and
  `installation_unsupported`. No built-in runtime returns
  `scope_unavailable` today.
* `unavailable`: `timeout` or `query_failed`. Malformed payloads, process
  failures and failed native requests must not become successful empty lists.
  Native error strings and raw server configuration are not copied into this
  result because they can contain credentials.

Readers enforce applicable native version requirements independently of
installation discovery. Pi's RPC skills and commands retain a version
preflight refusal as `unsupported` with `code: "version_unsupported"` and
optional `installedVersion` / `requiredVersion`, instead of a generic query
failure. The custom-command floor does not apply to its bundled SDK reads.
See [adapter version requirements](orientation.md#adapter-version-requirements).

`view` describes the source's coverage:

| View | Meaning |
|---|---|
| `discovered` | Directory/config discovery, not proof of a running agent's state |
| `context` | Native context's skill list, not every installed command |
| `registered` | Registered tools, including tools that are not active |
| `mcp-only` | MCP tools only; built-in and other extension tools are not included |

`partial:true` signals a native discovery error or pending/failed MCP startup.
Cursor directory discovery also marks unreadable or malformed metadata and
unavailable nested discovery partial.
Pi RPC also reports `partial:true` because it provides no loading diagnostics:
discovery completeness cannot be confirmed. It is independent of coverage: a complete MCP catalog is still `mcp-only`.
Devin also always reports `partial:true`: its per-entry diagnostics omit malformed
files that never become rows, so they cannot establish directory completeness.
Unknown fields are omitted. Enabled, active, loaded, auth and connection state
are separate concepts. Names and descriptions are native strings; OAR never
manufactures parameter schemas. A tool can reference its server through
`mcpServerId`.

## Skill provenance

`SkillEntry.source` keeps the native source string. Optional `scope` provides
one shared category: `builtin`, `user`, `project`, `managed` or `other`.
**An absent scope means unknown.** A recognized source that does not fit the
first four categories is `other`; an unrecognized or missing source is omitted.
Optional `plugin` preserves a native plugin or package identifier independently
of scope. A plugin skill can still be user-, project- or managed-scoped when
the native catalog says so. A plugin identity alone does not establish scope.

| Runtime | Native provenance → shared `scope` | `plugin` |
|---|---|---|
| Claude | `built-in` → builtin; `userSettings` → user; `projectSettings`/`localSettings` → project; `policySettings` → managed; `plugin`/`flagSettings`/`memoryStore`/`syncedSkills` → other | Native `pluginName` |
| Codex | `system` → builtin; `user` → user; `repo` → project; `admin` → managed | Native `pluginId` |
| Grok | `bundled` → builtin; `user` → user; `project` → project; `server`/`plugin`/`configToml` → other | Tagged source's `plugin_name` |
| Kimi | `builtin`/`user`/`project` unchanged; `extra` → other | Not supplied by this catalog |
| Pi SDK and RPC | `SourceInfo.scope` user/project unchanged; temporary → other | `SourceInfo.source` when `origin` is package; absent for top-level |
| Devin | Native `Builtin` → builtin; brand providers remain unknown | Not supplied by this catalog |
| Cursor | Measured SDK home loading roots → user; workspace/nested loading roots → project | Not inferred |
| OpenCode | Native built-in marker or verified built-in URI → builtin; verified user loading root → user; verified cwd/ancestor loading root → project | Not supplied by this catalog |

OpenCode preserves the returned path and compares its canonical filesystem path
with the native loading roots, including shared `.claude/skills` and
`.agents/skills`. It does not classify by a brand name appearing anywhere in a
path. Missing paths, unmatched custom/remote roots, ambiguous overlapping roots
and unknown `skill://` identities remain unclassified. The catalog still decides
which skills exist; OAR does not discover extra files or override native entries.
See [source evidence and version boundaries](../runtimes/inventory.md#skill-provenance).

## Commands

`CommandEntry` carries the native invocation `name`, with `description`,
`source`, `argumentHint` and `aliases` only when the native interface supplies
them. Names have no leading slash on the mapped runtimes. Descriptions and
argument hints are display metadata, not a parameter schema. No command
handler or prompt-template body is returned.

Pi lists extension commands and prompt templates, with `source: "extension"`
and `"prompt"` as in its native command catalog. Duplicate extension names
use Pi's resolved invocation names (for example `review:1` and `review:2`),
not an OAR-generated suffix. It does not add skill commands or terminal UI
built-ins. Skills remain in `skills()`; a host combines the two catalogs.
SDK discovery, including subprocess-mode reads without actual environment
changes, does not run extension commands or bind `session_start` hooks.
Subprocess-mode reads with environment changes use native RPC startup, which
does run those hooks, then read `get_commands`. This path separates
`source: "skill"` entries into `skills()` and retains extension/prompt source
labels for commands. RPC does not expose `argumentHint`, skill
`disableModelInvocation`, or loading diagnostics; those metadata fields are
absent and both inventories have `partial:true`.
Neither path executes a command or observes an existing session's later changes.

Claude lists `initialize.commands`, including native aliases and argument
hints. An explicit native `builtin: true` becomes `source: "builtin"`;
other provenance stays absent. The native catalog can contain skill-backed
commands also represented by `skills()`, so hosts merging the catalogs
should avoid duplicate picker entries. Account data from initialize is
never part of the inventory result.

A catalog describes native discovery, not a promise that each command starts
a model turn or works without interactive UI. The reader never executes a
command. Other selected interfaces return `unsupported`; in particular an
ACP session's `available_commands_update` is not an independent query.

## Implemented mapping

| Runtime | skills | commands | mcpServers | tools |
|---|---|---|---|---|
| Codex | `skills/list` | Unsupported on app-server | Paginated `mcpServerStatus/list` | Same native MCP catalog, including input schemas |
| Claude | `get_context_usage` skill frontmatter | `initialize.commands` | `mcp_status`, bounded startup polling | MCP names/descriptions when supplied; no invented schemas |
| Grok | `inspect --json` skills | Unsupported for independent queries | `inspect --json` configured/compatibility entries | Unsupported for independent queries |
| Pi | SDK resource loader | SDK extension runner and prompt templates | Unsupported | SDK registered tools, parameter schemas and active membership |
| Kimi | Native Web workspace skills; temporary loopback service, native state writes | Unsupported | Unsupported | Unsupported |
| OpenCode | v1 `debug skill`; v2 native HTTP catalog after plugin activation | Unsupported | Unsupported | Unsupported |
| Cursor | Measured SDK user/project directory discovery | Unsupported | Unsupported | Unsupported |
| Devin | Native `skills list --json`; can attempt network and write native state | Unsupported | Unsupported | Unsupported |
| Antigravity, DSH, Pi Durable, Qwen, Qoder, CodeBuddy, Factory | Unsupported on the selected interface | Unsupported on the selected interface | Unsupported on the selected interface | Unsupported on the selected interface |

Kimi starts a private loopback Web service, reads the complete workspace skill
catalog and stops its owned process tree. A workspace ID returned by registration
is unregistered only if absent from the preceding native workspace list;
existing registrations are retained. Native logs, indexes and the
persistent Web token can be created; no session or prompt is submitted.
Malformed skill files skipped by Kimi are absent from its catalog; a successful
complete catalog still has `partial:false`, while malformed responses fail.
See [Kimi's lifecycle and coverage](../runtimes/kimi.md#independent-skill-discovery).
Grok's session-only MCP tool view is not used. Claude's historical session-init tool
list is not used for these independent queries.
[Native evidence and limits](../runtimes/inventory.md).

The CLI's `oar inventory skills|commands|mcps|tools` prints the same results as JSON
([CLI reference](../../packages/cli/README.md#native-inventories)).

## Extension and verification

Custom runtimes should use `defineRuntime({id, session, ...})`: it fills missing
inventory methods with explicit unsupported results. A manually constructed
object typed as `Runtime` must implement all four methods.

Protocol tests cover cwd forwarding, pagination, malformed responses, partial
startup, response correlation, secret-bearing config exclusion, timeout cleanup,
and unsupported queries without subprocess launch. Mocked Pi SDK tests cover
registered versus active tools, command metadata and cleanup after late startup.
Native SDK/binary tests pin Pi command collisions, template scope, partial
load failures and unchanged skills, plus Claude command discovery without
a prompt. [Evidence and reproduction](../../experiments/commands-2026-10-11.md).
