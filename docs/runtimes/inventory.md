# Native runtime inventories

Original local probes, **2026-09-16**, workspace `rao`. The survey calls installed native
interfaces; it does not scan configuration files, ask a model to describe its
tools, or use online documentation.
[Reproducible probes and sanitized observations](../../experiments/inventory/README.md).

## November 17 update

DSH now queries its native global `skills.snapshot({cwd})` through the existing
plugin bridge, preserving the native completeness flag and source categories.
It creates no agent and makes no prompt. [Native comparison](../../experiments/dsh-skills/README.md)
records profile costs, malformed-file omission and provider failures.

Devin 3000.12.57 now uses its native `skills list --json` catalog, including
bundled skills. Brand labels do not identify user/project ownership. The
[Linux comparison](../../experiments/devin-skills/README.md) records malformed
file omission, native state writes and attempted background network access.

## November 16 update

Kimi 2.6.2's native Web workspace skill catalog is now integrated. It requires
a temporary loopback service and writes native logs/indexes/token state, but
creates no session or prompt. Successful complete native catalogs are
`partial:false`; malformed files skipped by Kimi remain absent. Claude
2.1.325 already returns built-in skills with their native source. Grok
1.0.77 returns cached bundled skills; OAR now preserves its object-shaped
source and path. [Current mapping](../spec/inventory.md#implemented-mapping),
[controls and limitations](../../experiments/runtime-skills-2026-11-16/README.md).
The remaining sections retain the September observations.

## Skill provenance

The [shared mapping table](../spec/inventory.md#skill-provenance) normalizes
explicit classifications while retaining native `source`. These sources were
checked on November 16; not every enum member has a live fixture observation.

- Claude 2.1.325: `get_context_usage.skills.skillFrontmatter` reports `source`
  and `pluginName`. The native source selector distinguishes built-in, settings,
  policy, plugin, flag, memory-store and synced-skill entries. Existing native
  controls observed built-in, project settings and plugin sources.
- Codex 0.169.0: `SkillScope` in app-server protocol `v2/plugin.rs` is
  system/user/repo/admin; `SkillMetadata.pluginId` is independent of that scope.
- Grok 1.0.77: `inspect::skill_entry_source` preserves `ConfigSource` for
  bundled/user/project/server/plugin/configToml. The tagged plugin variant uses
  the field `plugin_name`, not `pluginName`. Existing bundled-cache observations
  remain the evidence for why a cold empty list does not mean no bundled skills.
- Kimi 2.6.2: native Web `skillSourceSchema` is builtin/user/project/extra.
- Pi 1.5.2: `SourceInfo` has source, scope and origin in both SDK skill discovery
  and RPC `get_commands`. Package source strings retain their native npm/git
  identity; temporary does not imply builtin.
- OpenCode 1.19.5 returns the `<built-in>` marker. In 2.2.7/2.3.0 the built-in
  plugin registers `skill://opencode/SKILL.md`; 2.3.0 also registers
  `skill://report/SKILL.md`. No general URI-prefix rule is used. Filesystem
  classification uses real paths under home `.claude/skills`, `.agents/skills`,
  XDG config `opencode/skill(s)` and project ancestor `.claude/skills`,
  `.agents/skills`, `.opencode/skill(s)`. V1 stops at the repository root;
  v2 follows native ancestor discovery. V2's `OPENCODE_CONFIG_DIR` replaces its
  global config root. Unmatched roots stay unknown. Native definitions:
  [`ConfigDiscovery`](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/config/discovery.ts),
  [`ConfigSkillPlugin`](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/config/plugin/skill.ts),
  [`SkillPlugin`](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/plugin/skill.ts).

Projection regressions cover explicit enum values, absent/future classifications,
plugin identity with an independent user/project scope, Pi SDK/RPC parity and
path boundary controls. OpenCode native fixtures verify all six measured roots
in the [existing process/cleanup suite](../../sea-trial/vendor/opencode-skills.vendor.test.ts).
No skill bodies, raw configuration or credential values are added to the result.

## What each runtime actually exposes

These are **native capabilities**. The implemented subset is the
[OAR inventory contract](../spec/inventory.md); session-only and
alternate-transport capabilities below are not implicitly exposed.

| Runtime / tested version | Skills | MCP | Tools |
|---|---|---|---|
| Codex CLI 0.154.0 | App-server `skills/list`: metadata, path, scope, enabled, plugin identity | `mcpServerStatus/list`: paginated servers, auth/runtime status, errors, resources and tools | MCP tools include input schemas; no standalone built-in tool inventory found in the installed app-server request schema |
| Claude Code 2.1.273 | `get_context_usage` returns skill frontmatter and inclusion counters; initialize returns a broader command catalog | `mcp_status`: server state, errors, scope and tool names/annotations | MCP names/annotations live; `system/init.tools` supplies names in a session event (2.1.272 observation), not a standalone schema query |
| Grok 1.0.30 (04b7ffed98c6) | `inspect --json` and ACP `_x.ai/skills/list`, with different scopes | `mcp list --json`, `inspect`, and `_x.ai/mcp/list`; session ID adds live per-session metadata | Session MCP entries include tool name, description and enabled state; no parameter schemas observed, no built-in inventory endpoint verified |
| Kimi 0.42.0 (TypeScript kimi-code) | Native Web API session/workspace skills routes | Native Web API configured servers, auth state, and live server routes | Web API returns names, descriptions, source and active state; `input_schema` was null. These inventory routes are not exposed by the tested ACP surface |
| Pi SDK 0.84.2 and 0.84.4 | Resource loader `getSkills()`, including source and diagnostics | No dedicated core MCP inventory API found in inspected SDK declarations; extensions may implement MCP | `getAllTools()` returns parameter schemas and provenance; `getActiveToolNames()` separately identifies active tools |

OpenCode skill discovery is now measured separately: [v1 CLI and v2 HTTP catalogs](../../experiments/opencode-skills/README.md), including cold-start readiness and cleanup.

Cursor SDK 1.4.0 discovery was subsequently measured in the
[Cursor directory study](../../experiments/cursor-skills/README.md).
Antigravity, CodeBuddy, Cursor, Devin, DSH, Factory, Qoder and Qwen were not probed
in the original baseline;
At that baseline OAR answered all four of their inventory queries `unsupported`
(`transport_unavailable`), as it does for Kimi, Pi Durable and Mister Morph
([defineRuntime default](../../packages/oar/src/contracts/runtime.ts)). No full-fidelity three-way intersection is verified across the five
probed **OAR-selected transports**. Skills are the broadest commonality, but Kimi
needs a different transport and Claude's context view is narrower than a
discovery catalog. A tool list is not necessarily a built-in tool list, a
schema catalog, or a permission grant.

## Codex

The probe initializes an app-server with experimental APIs enabled, calls
`skills/list {cwds:[cwd]}`, and exhausts
`mcpServerStatus/list {detail:"full",limit:2,cursor}`.

Observed: 25 skills (23 enabled, 2 disabled; 19 user, 6 system). MCP pagination
returned 6 servers over 3 pages and 55 tools, all with `inputSchema`. Tool
records can also carry description, annotations, output schema and title. On
a fresh app-server without a thread every `runtimeStatus` was null. Auth
support/state and a discovered tool catalog do not prove a live thread has
connected or enabled every tool; missing status stays unknown.

The installed binary's generated TypeScript request union has these inventory
methods but no general built-in tools query, and a `tools/list` probe returned
-32600. This constrains the investigated interface; it does not mean Codex
has no built-in tools.

## Claude Code

Bidirectional print-mode control protocol, initialized without a user prompt,
with session persistence disabled.

* `initialize` returned 53 commands and 6 agent descriptions. Commands include
  aliases and argument hints; **commands are not synonymous with skills**.
* `get_context_usage {detail:"summary"}` returned 16 skill frontmatter entries
  with name, source, plugin name and token counts; total/included counters were
  both 16. This view gives no discovery paths or disable flags.
* `mcp_status` first returned pending/failed servers; after polling, 2 servers:
  1 connected, 1 failed. The connected server supplied 1 tool with name and
  annotations, without input schema or description.
* Context usage reported that MCP tool with `isLoaded:false`. Connected,
  discovered and loaded cannot be collapsed into one flag.
* `list_tools` and `list_skills` control requests were rejected as unsupported.

No `system/init` event arrived before a prompt. An OAR scripted-model trace
(**2026-09-15, Claude 2.1.272**) has `system/init` with 25 tool names, 21 skill
names and 2 MCP server entries: session-event evidence, **not** a 2.1.273
standalone query or tool parameter schemas. The replay helper extracts only
counts/types/version and deduplicates repeated trace representations.

## Grok

Run `grok agent --no-leader stdio`, initialize ACP, and use vendor extensions.
The native discovery views differ:

* `inspect --json`: 29 skills and 2 MCP compatibility/config entries.
* `_x.ai/skills/list {cwd}`: 28 skills, all enabled, with descriptions, paths,
  invocation hints, scope and invocation restrictions.
* `grok mcp list --json`: an empty list.
* `_x.ai/mcp/list {}`: 1 agent-level catalog entry, without live tools.
* After cached authentication and creating an owned empty session,
  `_x.ai/mcp/list {sessionId}`: 2 entries with nested `session` metadata.
  After startup, one entry exposed 1 tool under `session.tools` (name,
  description, enabled); the other only its enabled state.

These counts must not be merged or substituted for one another. `session.tools`
is nested, so looking only for a top-level `tools` field falsely reports no
support; startup is asynchronous, so an immediate read also misses it.

Observed notifications: `_x.ai/mcp/servers_updated`, `_x.ai/mcp/init_progress`,
`_x.ai/mcp_initialized` and `_x.ai/mcp/server_status` (notification names, not
request methods). No MCP parameter schema was returned. `tools/list` and
`_x.ai/tools/list` returned -32601; no built-in tool inventory was verified.
Probe sessions were closed and deleted through native operations
(`success:true`).

## Kimi

Installed **TypeScript kimi-code 0.42.0**, not the older Python kimi-cli. ACP
initialize advertises MCP HTTP/SSE transport support, which is not a server
inventory. ACP `skills/list`, `tools/list` and `mcp/list` all returned -32601.

The binary contains a native Web API. The probe launches
`kimi web --no-open --host 127.0.0.1 --port 0` with its default token
protection and holds the startup bearer token in memory only.

| Native Web route | Observation |
|---|---|
| `GET /api/v1/sessions/{id}/skills` | 10 skills: 9 builtin, 1 user; name, description, path, source, type, invocation restriction |
| `GET /api/v1/workspaces/{id}/skills` | Same 10 skills for the probe workspace |
| `GET /api/v1/tools?session_id={id}` | 27 builtin tools, all active; all 27 input schemas null |
| `GET /api/v2/mcp/servers?cwd=...` | Successful empty configured-server list |
| `GET /api/v2/mcp/auth-statuses?verify=false&cwd=...` | Successful empty offline auth-state list |
| `GET /api/v1/mcp/servers` | Successful empty live-server list; native selection is the most recent session |

Embedded implementation inspection: the v1 tools projection deliberately sets
`input_schema:null`, derives active state from policy, and can label MCP tools
with `source:mcp` and `mcp_server_id`; the live MCP route projects server
transport/status/tool count/error. Those **nonempty MCP fields were inspected,
not observed live**: the workspace had no Kimi MCP servers.

The probe created its own empty session, submitted no prompt, and deleted it
(`deleted:true`). Session queries can activate a session, and native startup
can update workspace bookkeeping.

**Integration limit:** a separate Web process is not the existing ACP agent.
Its tools and live MCP connections must not be presented as that ACP session's
state. The v1 MCP route's implicit most-recent-session selection is unsuitable
for project isolation without additional native support.

## Pi

Use `createAgentSessionServices`, `createAgentSessionFromServices` and
`SessionManager.inMemory`; dispose the session afterward. The probe needs no
prompt or trust configuration write.

* SDK **0.84.2** (OAR's dependency at the time): 1 skill, 7 registered tools
  with parameter schemas, 4 active tools, 1 extension, no skill/extension
  diagnostics.
* SDK **0.84.4** (rao's dependency): 1 skill, 8 registered tools with parameter
  schemas, the same 4 active tools, 1 extension, no diagnostics.
* The active built-ins were read, bash, edit and write; registered tools are a
  larger set than active tools.
* Skill records include file/base directory, description, invocation restriction
  and source. Tool records include name, description, parameters, prompt
  guidelines and source.

The installed Pi CLI reported 0.85.1; these results come from the two SDK
versions, **not that CLI**. The inspected SDK has no standard MCP server/status
list. An extension can contribute tools or implement an MCP bridge, so absence
of a core query does not rule such extensions out, and generic extension
provenance does not guarantee an MCP server identity.

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
   independently, or synthesize tool schemas to fill missing native fields.

The 2026-09-16 implementation added three independent queries (skills, MCP servers, tools) on this
basis, with no Session query API; see the [mapping and validation](../spec/inventory.md).
Remaining native evidence gaps: Kimi nonempty MCP responses, Pi
extension-provided MCP provenance, built-in tool catalogs on Codex/Grok, and a
fresh Claude 2.1.273 post-prompt init snapshot. No model prompt was sent to
close them.

## Commands (2026-10-11)

The independent inventory contract also exposes `commands()`. Pi SDK
1.1.0 supplies extension invocation names and prompt templates from the
loaded SDK session; Claude 2.1.296 supplies `initialize.commands`. Neither
reader prompts a model. The other runtime interfaces return
unsupported for this independent query; their interactive or session-bound
commands are not guessed from files or terminal help.
[Current mapping](../spec/inventory.md#commands),
[per-interface evidence and reproduction](../../experiments/commands-2026-10-11.md).

## Cursor directory discovery

Cursor SDK 1.4.0 has no independent query. OAR lists the measured SDK user/project
roots with `view: "discovered"`, preserves directory names and invocation flags,
and labels scope by loading root. It starts no SDK, hooks or MCP servers.
Git workspaces reuse the SDK's ripgrep companion for nested ignore behavior;
missing nested discovery or malformed/unreadable metadata makes the result
partial. The [native parity case](../../experiments/cursor-skills/README.md)
compares the real SDK loader and OAR on identical fixtures on every CI platform.
