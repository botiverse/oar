# Independent runtime inventories

Every runtime has four readers, `skills`, `commands`, `mcpServers` and
`tools`, each taking an installation and optional `{ cwd, timeoutMs, env }`.
The types are in `contracts/inventory.ts`; which runtimes answer which
query, and from what native source, is in each adapter and in the
[native evidence page](../runtimes/inventory.md).

```ts
const runtime = defaultRuntimes.require("codex");
const installation = await runtime.installation?.();
if (installation?.kind === "available") {
  const skills = await runtime.skills(installation, { cwd: "/my/project" });
}
```

## What a reader does

A reader asks the runtime what it would load in `cwd`, independently of
any running agent. There are no session inventory methods: a fresh
process's connections and defaults do not describe an existing agent, and
servers a session was given in `SessionOptions.mcpServers` are that
session's, so `mcpServers()` never lists them. Inventory results never
enter a record stream.

No prompt is sent. Some readers only read skill files; others start the
runtime in `cwd` the way a session would, and those can run that
workspace's code (project extensions, a stdio MCP server) and connect
configured MCP servers. Do not take an inventory of a directory you do not
trust. `env` follows the
[reader environment rules](orientation.md#environment). Pi's in-process SDK
loads inventories using the host environment. If an overlay changes it,
Pi returns `unsupported` with `scope_unavailable` before loading extensions.
Process-backed inventories follow the [native reader deadline](orientation.md#native-reader-deadlines).

## Results

A failure is never an empty list. Malformed payloads, failed processes and
failed native requests are `unavailable`; a runtime or interface with no
such query is `unsupported`; an empty `ok` list is the runtime saying it
has none. Most readers return a classified reason and omit native text or raw server
configuration. The OpenCode 1.x skills reader retains a redacted diagnostic
of at most 500 characters from its native command.
[Diagnostic handling](../../packages/oar/src/runtimes/opencode/skills-v1.ts).

An `ok` result says how much it covers. `view` names the source: the
runtime's catalog of what it would load (`discovered`), its live context
(`context`), all registered tools including inactive ones (`registered`),
or MCP tools only (`mcp-only`, never to be shown as all tools).
`partial: true` means the reader knows its coverage is incomplete, for
example a native discovery error, an MCP server that had not started, or a
file search that was unavailable or cut off. A result without it still
does not promise that every file on disk is valid. Enabled, active, loaded, auth and
connection state are separate facts and are never folded into one.

## Skill provenance

`scope` is one shared category (`builtin`, `user`, `project`, `managed`,
`other`), mapped from the runtime's own label or from a verified native
discovery root the file was loaded from. An absent scope means unknown,
never a guess: OAR does not classify by a brand name in a path,
and a plugin identity alone does not establish scope. `plugin` keeps the
native plugin or package identity independently of scope.

`userInvocable` says whether a person can run the skill directly. Absent
means the runtime did not say; `false` means its metadata disallows it or
its verified command catalog does not offer it. Enabled and
model-invocation flags do not substitute for it.

## Commands

`commands()` returns native invocation names with display metadata only:
no handler, prompt body or parameter schema, and the reader never runs a
command. A catalog does not promise that a command starts a model turn or
works without the runtime's own UI. It can include skill-backed commands
that `skills()` also returns, so a host merging the two avoids duplicate
entries. An ACP session's `available_commands_update` is a session's
state, not an independent query.

## Custom runtimes

`defineRuntime({ id, session, ... })` fills missing readers with
`unsupported`. An object typed as `Runtime` by hand must implement all four.
