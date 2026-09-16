# Native skills, MCP and tool inventories

Local probe baseline: **2026-09-16**, workspace `rao`. This survey calls installed
native interfaces; it does not infer inventory by scanning configuration files,
ask a model to describe its tools, or use online documentation.
[Reproducible probes and sanitized observations](../../experiments/inventory/README.md).

## What each runtime actually exposes

These are **native capabilities**. The implemented independent-query subset is
listed in the [OAR inventory contract](../spec/inventory.md); session-only and
alternate-transport capabilities below are not implicitly exposed.

| Runtime / tested version | Skills | MCP | Tools |
|---|---|---|---|
| Codex CLI 0.154.0 | App-server `skills/list`: metadata, path, scope, enabled, plugin identity | `mcpServerStatus/list`: paginated servers, auth/runtime status, errors, resources and tools | MCP tools include input schemas; no standalone built-in tool inventory found in the installed app-server request schema |
| Claude Code 2.1.273 | `get_context_usage` returns skill frontmatter and inclusion counters; initialize returns a broader command catalog | `mcp_status`: server state, errors, scope and tool names/annotations | MCP names/annotations live; `system/init.tools` supplies names in a session event (historical 2.1.272 observation), not a standalone schema query |
| Grok 1.0.30 (04b7ffed98c6) | `inspect --json` and ACP `_x.ai/skills/list`, with different scopes | `mcp list --json`, `inspect`, and `_x.ai/mcp/list`; session ID adds live per-session metadata | Session MCP entries include tool name, description and enabled state; no parameter schemas observed, no built-in inventory endpoint verified |
| Kimi 0.42.0 (TypeScript kimi-code) | Native Web API session/workspace skills routes | Native Web API configured servers, auth state, and live server routes | Web API returns names, descriptions, source and active state; `input_schema` was null. These inventory routes are not exposed by the tested ACP surface |
| Pi SDK 0.84.2 and 0.84.4 | Resource loader `getSkills()`, including source and diagnostics | No dedicated core MCP inventory API found in inspected SDK declarations; extensions may implement MCP | `getAllTools()` returns parameter schemas and provenance; `getActiveToolNames()` separately identifies active tools |

There is no verified full-fidelity three-way intersection across all five
**OAR-selected transports**. Skills are the broadest native commonality, but
Kimi requires a different transport and Claude's context view is narrower than
a discovery catalog. A tool list is not necessarily a built-in tool list,
a schema catalog, or a permission grant.

## Codex

The probe initializes an app-server with experimental APIs enabled, calls
`skills/list {cwds:[cwd]}`, and exhausts
`mcpServerStatus/list {detail:"full",limit:2,cursor}`.

Observed: 25 skills (23 enabled, 2 disabled; 19 user, 6 system). MCP pagination
returned 6 servers over 3 pages and 55 tools, all with `inputSchema`.
Tool records can also contain description, annotations, output schema and title.
This was a fresh app-server without a thread: every `runtimeStatus` was null.
Auth support/state and a discovered tool catalog do not prove a live thread
has connected or enabled every tool. Missing status must remain unknown.

The installed binary's generated TypeScript request union contains these
inventory methods but no general built-in tools query. A negative
`tools/list` probe returned -32600. This constrains the investigated interface;
it does not mean Codex has no built-in tools.

## Claude Code

Use the bidirectional print-mode control protocol, initialized without a user
prompt. The probe disables session persistence.

* `initialize` returned 53 commands and 6 agent descriptions. Commands include
  aliases and argument hints; **commands are not synonymous with skills**.
* `get_context_usage {detail:"summary"}` returned 16 skill frontmatter entries
  with name, source, plugin name and token counts; total/included counters were
  both 16. This context view does not provide discovery paths or disable flags.
* `mcp_status` initially returned pending/failed servers. After polling, there
  were 2 servers: 1 connected, 1 failed. The connected server supplied 1 tool
  with name and annotations, without an input schema or description.
* Context usage separately reported that MCP tool with `isLoaded:false`.
  Connected, discovered and loaded therefore cannot be collapsed into one flag.
* `list_tools` and `list_skills` control requests were rejected as unsupported.

No `system/init` event was observed before a prompt in this probe. An existing
OAR scripted-model trace from **2026-09-15, Claude 2.1.272** contains
`system/init` with 25 tool names, 21 skill names and 2 MCP server entries.
This is historical session-event evidence, **not** a fresh 2.1.273 standalone
query or evidence of tool parameter schemas. The replay helper extracts only
counts/types/version; repeated trace representations are deduplicated.

## Grok

Run `grok agent --no-leader stdio`, initialize ACP, and use vendor extensions.

Observed native discovery views differ:

* `inspect --json`: 29 skills and 2 MCP compatibility/config entries.
* `_x.ai/skills/list {cwd}`: 28 skills, all enabled, with descriptions, paths,
  invocation hints, scope and invocation restrictions.
* `grok mcp list --json`: an empty list.
* `_x.ai/mcp/list {}`: 1 agent-level catalog entry, without live tools.
* After cached authentication and creating an owned empty session,
  `_x.ai/mcp/list {sessionId}`: 2 entries with nested `session` metadata.
  After waiting for startup, one entry exposed 1 tool under `session.tools`,
  with name, description and enabled; the other only exposed enabled state.

These counts must not be merged or substituted for one another. In particular,
`session.tools` is nested; looking only for a top-level `tools` field falsely
reports no support. Startup is asynchronous; an immediate read also misses it.

Observed notifications include `_x.ai/mcp/servers_updated`,
`_x.ai/mcp/init_progress`, `_x.ai/mcp_initialized` and
`_x.ai/mcp/server_status`. Notification names are not request methods.
No MCP parameter schema was returned by the tested inventory.
`tools/list` and `_x.ai/tools/list` returned -32601; no built-in tool inventory
was verified. Probe sessions were closed and deleted through native operations,
with `success:true`.

## Kimi

This is the installed **TypeScript kimi-code 0.42.0**, not the older Python
kimi-cli repository. ACP initialize advertises MCP HTTP/SSE transport support;
those flags do not advertise a server inventory. ACP requests `skills/list`,
`tools/list` and `mcp/list` all returned -32601.

The installed binary contains a native Web API. The probe launches
`kimi web --no-open --host 127.0.0.1 --port 0`, retaining its default token
protection. It holds the startup bearer token in memory only.

| Native Web route | Observation |
|---|---|
| `GET /api/v1/sessions/{id}/skills` | 10 skills: 9 builtin, 1 user; name, description, path, source, type, invocation restriction |
| `GET /api/v1/workspaces/{id}/skills` | Same 10 skills for the probe workspace |
| `GET /api/v1/tools?session_id={id}` | 27 builtin tools, all active; all 27 input schemas null |
| `GET /api/v2/mcp/servers?cwd=...` | Successful empty configured-server list |
| `GET /api/v2/mcp/auth-statuses?verify=false&cwd=...` | Successful empty offline auth-state list |
| `GET /api/v1/mcp/servers` | Successful empty live-server list; native selection is the most recent session |

Local embedded implementation inspection confirms that the v1 tools projection
deliberately sets `input_schema:null`, derives active state from policy, and can
label MCP tools with `source:mcp` and `mcp_server_id`. The live MCP route projects
server transport/status/tool count/error. Those **nonempty MCP fields were
inspected, not observed live**: this workspace had no Kimi MCP servers.

The probe created its own empty session, submitted no prompt, and deleted it
(`deleted:true`). Session queries can activate a session and native startup can
update workspace bookkeeping.

**Integration limit:** a separate Web process is not the existing ACP agent.
Its tools and live MCP connections must not be presented as that ACP session's
state. The v1 MCP route's implicit most-recent-session selection is particularly
unsuitable for project isolation without additional native support.

## Pi

Use `createAgentSessionServices`, `createAgentSessionFromServices` and
`SessionManager.inMemory`; dispose the session afterward. No prompt or trust
configuration write is required by this probe.

* SDK **0.84.2** (oar dependency): 1 skill, 7 registered tools with parameter
  schemas, 4 active tools, 1 extension, no skill/extension diagnostics.
* SDK **0.84.4** (rao dependency): 1 skill, 8 registered tools with parameter
  schemas, the same 4 active tools, 1 extension, no diagnostics.
* The active built-ins were read, bash, edit and write. Registered tools are
  a larger set than active tools.
* Skill records include file/base directory, description, invocation restriction
  and source information. Tool records include name, description, parameters,
  prompt guidelines and source information.

The installed Pi CLI reports 0.85.1, but these results came from the two named
SDK versions, **not that CLI**. The inspected SDK has no dedicated standard MCP
server/status list. An extension can contribute tools or implement an MCP
bridge; absence of a core query does not mean such extensions cannot exist.
Generic extension provenance does not guarantee an MCP server identity.

## Implications for OAR and Rao

Preserve the native boundary:

1. Separate skills discovery, MCP server inventory and tool inventory. Return
   explicit unsupported/unavailable-on-transport results instead of fake empty
   success when no native read operation exists.
2. Keep query scope: cwd, native process, session identity, and observation time.
   A fresh dashboard probe is not a read of an existing project's agent.
3. Preserve optional fields: enabled, active, loaded, connected, auth state,
   description, schema and source are independently available.
4. Distinguish partial startup, per-server errors, unsupported query and a
   successful empty list. Paginate Codex; await MCP startup within a bounded
   period for Claude/Grok.
5. Do not reconstruct catalogs by scanning configuration, connect to MCP servers
   independently, or synthesize tool schemas just to fill missing native fields.

OAR now implements three independent runtime queries based on this survey; see
the [mapping and validation](../spec/inventory.md). No session query API or Rao UI
change is included. Remaining native evidence gaps:
Kimi nonempty MCP responses, Pi extension-provided MCP provenance, builtin tool
catalogs on Codex/Grok, and a fresh Claude 2.1.273 post-prompt init snapshot.
No model prompt was sent to close those gaps.
