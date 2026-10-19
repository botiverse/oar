# Independent runtime inventories

OAR exposes four independent native queries on every runtime:

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
defaults to 15 seconds and must be positive and finite.

These operations discover native information independently of existing agents.
There are **no Session inventory methods, session IDs, or session query mode**.
A fresh process's connections or active defaults do not describe an existing
agent. No model prompt is submitted, but the runtime starts in `cwd` the way
it would for a session: it can load and run that workspace's code (pi's
project extensions, a configured stdio MCP server) and connect configured
MCP servers. Do not take an inventory of a directory you do not trust; this
holds for every reader. Pi uses a temporary in-memory SDK session,
without writing trust configuration, and disposes it after discovery.
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

`view` describes the source's coverage:

| View | Meaning |
|---|---|
| `discovered` | Directory/config discovery, not proof of a running agent's state |
| `context` | Native context's skill list, not every installed command |
| `registered` | Registered tools, including tools that are not active |
| `mcp-only` | MCP tools only; built-in and other extension tools are not included |

`partial:true` signals a native discovery error or pending/failed MCP startup.
It is independent of coverage: a complete MCP catalog is still `mcp-only`.
Unknown fields are omitted. Enabled, active, loaded, auth and connection state
are separate concepts. Names and descriptions are native strings; OAR never
manufactures parameter schemas. A tool can reference its server through
`mcpServerId`.

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
Discovery does not run extension commands or bind `session_start` hooks, so
this is the initial loaded catalog, not commands a live session adds later.

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
| Kimi, Cursor, Antigravity, OpenCode, Pi Durable | Unsupported on the selected interface | Unsupported on the selected interface | Unsupported on the selected interface | Unsupported on the selected interface |

Kimi's separate native Web API was probed but is not integrated. Grok's
session-only MCP tool view is not used. Claude's historical session-init tool
list is not used for these independent queries.
[Native evidence and limits](../runtimes/inventory.md).

The CLI's `oar skills|commands|mcps|tools` print the same results as JSON
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
