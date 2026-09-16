# Independent runtime inventories

OAR exposes three independent native queries on every runtime:

```ts
const runtime = runtimes.require("codex");
const installation = await runtime.installation?.();
if (installation?.kind === "available") {
  const skills = await runtime.skills(installation, { cwd: "/my/project" });
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
agent. No model prompt is submitted; native startup can load extensions and
connect configured MCP servers. Pi uses a temporary in-memory SDK session,
without writing trust configuration, and disposes it after discovery.

## Results

`InventoryResult<T>` is a discriminated union:

* `ok`: `items`, absolute directory in `scope.cwd`, `observedAt`, `view` and
  `partial`. An empty list is a successful native empty result.
* `unsupported`: stable `code` and explanatory `reason`. No native query,
  unavailable transport, unavailable scope, and incompatible installation are
  distinct codes. The default supplied by `defineRuntime` is
  `transport_unavailable`.
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

## Implemented mapping

| Runtime | skills | mcpServers | tools |
|---|---|---|---|
| Codex | `skills/list` | Paginated `mcpServerStatus/list` | Same native MCP catalog, including input schemas |
| Claude | `get_context_usage` skill frontmatter | `mcp_status`, bounded startup polling | MCP names/descriptions when supplied; no invented schemas |
| Grok | `inspect --json` skills | `inspect --json` configured/compatibility entries | Unsupported for independent queries |
| Kimi | Unsupported on the selected interface | Unsupported on the selected interface | Unsupported on the selected interface |
| Pi | SDK resource loader | Unsupported | SDK registered tools, parameter schemas and active membership |

Kimi's separate native Web API was probed but is not integrated. Grok's
session-only MCP tool view is not used. Claude's historical session-init tool
list is not used for these independent queries.
[Native evidence and limits](../runtimes/inventory.md).

The CLI exposes the same operations as JSON:
`oar skills|mcps|tools [runtime] [--cwd directory] [--timeout milliseconds]`.
Omitting runtime queries all registered runtimes.

## Extension and verification

Custom runtimes should use `defineRuntime({id, session, ...})`: it fills missing
inventory methods with explicit unsupported results. A manually constructed
object typed as `Runtime` must implement all three methods; this is a TypeScript
surface change from 0.3.x.

Protocol tests cover cwd forwarding, pagination, malformed responses, partial
startup, response correlation, secret-bearing config exclusion, timeout cleanup,
and unsupported queries without subprocess launch. Mocked Pi SDK tests cover
registered versus active tools and cleanup after late startup. Existing Session
contracts and adapters are unchanged; inventory results do not enter their
record streams.
