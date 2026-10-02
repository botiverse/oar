# goose (investigation)

**Reference only; no OAR adapter.** A live-probe investigation, not an adapter
mapping. Evidence baseline: **goose 1.50.0** (`~/.local/bin/goose`), Linux
x86_64, probed 2026-09-12; the version is an evidence baseline, not a support
range. No real provider credentials were used: a placeholder provider pointed
at an unreachable host let sessions be created while only the model-catalogue
refresh failed (recorded in `provider_inventory_entries.last_refresh_error`).
`goose serve` ran with a one-off local `GOOSE_SERVER__SECRET_KEY`, bound to
127.0.0.1. Statements are observations unless labelled as a vendor
declaration. See the [runtime index](../README.md) for status conventions.

Supply chain: the PyPI package `goose-ai` (0.1.0, author `anupamas0x1`) is
**not** Block's goose. The real binary comes from the official install script
and lands at `~/.local/bin/goose`.

## Native concepts and calling interfaces

goose presents two ACP faces:

- **`goose acp`**: stdio. **stdin EOF makes the process exit before async
  provider resolution finishes**, leaving a 0-byte `sessions.db` and a stray
  `sessions.db-journal`; a FIFO has to hold stdin open for a full flow.
- **`goose serve`**: HTTP + WebSocket, default 127.0.0.1:3284.

All three paths (stdio / HTTP POST / WS) return an **identical** `initialize`
result (vendor declaration, verbatim):

```json
{"protocolVersion":1,"agentCapabilities":{"loadSession":true,
 "promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},
 "mcpCapabilities":{"http":true,"sse":false},
 "sessionCapabilities":{"list":{},"delete":{},"close":{}},"auth":{},
 "_meta":{"goose":{"recipeParameterScopes":{},"localInference":{}}}},
 "authMethods":[{"id":"goose-provider","name":"Configure Provider",
                 "description":"Run `goose configure` ..."}],
 "agentInfo":{"name":"goose","version":"1.50.0"}}
```

The database records which face created a session in `sessions.session_type`
(`'acp'`).

HTTP routes and auth (observed on 127.0.0.1:3291): `/` = 404, `/health` = 200
`ok`, `/status` = 200 `ok`, `/acp` = 401, `/api` `/openapi.json` `/docs` = 404.
The only accepted auth header is `x-secret-key`; `secret-key`, `x-api-key`,
`authorization`, `authorization: Bearer` and `?secret_key=` all return 401.

Transport is **split-channel**: POST is write-only, WS is the full-duplex
request + response + notification channel.

```
POST /acp  no connection id        -> 200 + inline JSON-RPC result; response header carries acp-connection-id
POST /acp  valid connection id     -> 202 Accepted, content-length: 0   [submit only, no result]
POST /acp  forged id               -> 404
POST /acp  after bootstrap, no id  -> body "Acp-Connection-Id header required"
GET  /acp  WS upgrade              -> 101, mints a brand-new acp-connection-id
always:  access-control-expose-headers: acp-connection-id,acp-session-id
on 101:  access-control-allow-origin: http://goose.local   [built-in default allowed origin]
```

## Capability details

### Storage, the fourth model: mutable rows as the only truth

One SQLite file, `~/.local/share/goose/sessions/sessions.db`, in WAL mode,
`user_version` = 0, `schema_version` table at version 1. **Only mutable
relational rows: no append-only log, no per-session file.** Tables: `sessions`,
`messages`, `usage_ledger` (with `cost_source` and `is_compaction`),
`provider_inventory_entries`, `provider_inventory_models`, `schema_version`.
The cost ledger, the provider/model catalogue and the sessions share one
database.

The four-way storage split across the harnesses surveyed:

| harness | persistent truth | projection |
|---|---|---|
| Codex | append-only rollout JSONL (sole truth) | SQLite, tracked by byte offset |
| Claude Code | message-tree DAG, one JSONL per session | none |
| opencode | event sourcing inside `opencode.db` (`event` + `event_sequence`) | mutable projection tables in the same database |
| **goose** | mutable rows in `sessions.db` | no separate append-only frame log observed |

`messages` stayed at **0 rows** throughout (no model turn completed), so
frame-level granularity is unmeasured. No append-only frame log was found in the
inspected storage; that is not a proof about untested storage paths or full
model turns.

### Event model

JSON-RPC 2.0 notifications named `session/update`, discriminated by
`sessionUpdate`. Observed: `usage_update` (`{"used":0,"size":128000}`),
`available_commands_update`, `current_mode_update`. The names carry **no version
suffix** (contrast opencode's `.N`-suffixed persistent events); the only version
number seen is the `enabled_extensions.v0` key inside the `extension_data` JSON
blob.

`available_commands_update` lists the builtin commands
`prompts` / `prompt` / `compact` / `clear` / `skills` / `doctor` / `status`,
plus `goal` (a target that must be satisfied before completion) and `grind`
(keep going until `max_turns`). Skill-derived commands carry
`_meta.commandType: "Skill"`.

### Identity and multiple observers

An operator-configured shared secret, `x-secret-key`, authenticates clients;
it is a credential, not a server-minted identity. The server mints two
identities: `acp-connection-id` (a UUID) and `sessionId` (a `YYYYMMDD_N`
counter). The database has **no owner column**; identity is the local user plus
`working_dir`, with one extra connection layer over HTTP. This mirrors
opencode, where both the workspace and the sessionID are client-declared.

- **Multiple observers: yes, as separate independent streams.** Two
  connections both `session/load` the same sessionId and each receive the full
  modes + configOptions and two `session/update` notifications. When B sends
  `session/set_mode` to switch to approve, **B receives `current_mode_update`
  and the still-connected A receives zero frames within 4 seconds**, while
  `sessions.goose_mode` does change to approve and `updated_at` moves forward.
  State is shared and mutable; events are per-connection; no cross-connection
  mode update was observed in that window.
- **Connections are neither reusable nor transferable.** A WS upgrade that
  carries an existing `acp-connection-id` is ignored and a new one is minted
  (asked to join `5b9402c8…`, got back `0e1f72f6…`).
- **A session outlives its connection.** Closing A's socket leaves B working,
  and a later fresh connection C can `session/load` the same session.
- **No cursor anywhere.** `session/load` delivers one complete snapshot of
  current state, not a resume from a position in history. "Which incarnation is
  this" has no server-side carrier.
- **Id stability across processes: yes.** After `kill -9` on the serve process,
  a new process on a new port loaded `20260912_6` with `currentModeId` still
  approve: the pre-SIGKILL write survived via WAL recovery.
- **Death boundary: no terminal frame.** `kill -9` on the server leaves no
  session-level or connection-level termination record in the log. The last
  two lines are from the earlier *client* disconnect
  (`WebSocket error: ... Connection reset without closing handshake`, carrying
  the connection_id). `sessions.db-wal` simply stops at 482 KB,
  un-checkpointed.
- **`sessionId` is a date counter**, so two machines produce `20260912_6`
  independently; the id cannot travel without being qualified.

In the vocabulary shared across the samples:

| Property | goose |
|---|---|
| identity authority | connection and session IDs are server-minted; the shared secret is operator-configured |
| uniqueness scope | `acp-connection-id` is a globally unique UUID; `sessionId` is unique only inside the local `sessions.db` |
| connection identity, by on-wire addressability | explicit id, visible at the WebSocket layer, but neither reusable nor transferable |
| resumability floor | none in the append-only sense; `session/load` returns a current-state snapshot, which survives SIGKILL via WAL recovery |
| history paging cursor | none |
| live stream resume cursor | none |
| runtime side resume material | mutable relational rows: `session/load` restored session settings; model-context restoration after real turns is unverified (no model turn ran) |
| broadcast and subscription separated | not separated, and weaker: no mode-change broadcast observed; other event families untested |

### Capability honesty: the strongest of the four, with three gaps

Strengths: genuine capability negotiation, honest negative declarations
(`audio:false`, `sse:false`), and namespaced `_meta.goose` vendor extensions.
Gaps:

1. It declares `sessionCapabilities.list:{}`, but `session/list` **returns
   `{"sessions":[]}` under every condition tried**, including for a session
   just created by `session/new` on the same connection, while the database
   held 7 rows.
2. It declares `authMethods:[goose-provider]`, but with no provider configured
   the failure is a generic `-32603 Internal error` /
   `"Failed to resolve provider: Configuration value not found: GOOSE_PROVIDER"`,
   not an ACP auth challenge.
3. `session/close` is connection-level only: it returns `{}`, the database row
   remains, `archived_at` stays empty, and another connection can `session/load`
   it right back, mode included. Close is not end. Loading a non-existent id
   does give a **typed** error: `-32002 Resource not found` /
   `"Session not found: 20260912_999"`.

### Deployment and lifecycle

`goose serve` **refuses to start without `GOOSE_SERVER__SECRET_KEY`** (exit 1):

```
Error: GOOSE_SERVER__SECRET_KEY must be set to start `goose serve`;
pass --dangerously-unauthenticated to run without ACP authentication
```

That is stricter than opencode, which warns and runs unauthenticated. Default
bind is 127.0.0.1, the route surface is tiny, there is no OpenAPI document,
`/health` and `/status` are unauthenticated, and the default allowed origin is
`http://goose.local`.

CLI logs are one file per invocation:
`~/.local/state/goose/logs/cli/<YYYY-MM-DD>/<YYYYMMDD_HHMMSS>.log`, tracing JSON
lines with a `target` field (`goose_cli::cli`, `goose::acp::server`,
`goose::acp::server_factory`, `agent_client_protocol_http::websocket_server`,
`goose::providers::inventory`).

**No environment lifecycle events observed.** goose is a purely local process;
`serve` reported no environment create/suspend/destroy in the probes. The only lifecycle lines are
connection-level WebSocket errors.

### Tools and permissions

Four session modes are negotiated **in the protocol** at creation and persisted
as `sessions.goose_mode`: `auto` (auto-approve), `approve` (ask every time),
`smart_approve` (ask only for sensitive operations), `chat` (talk only, no tool
calls). Permission state is **durable session state** (contrast Codex, which
writes `sandbox_policy` into the append-only log on every turn).
`session/set_mode` switches at runtime and lands in the database immediately.

### Extension points

Eight bundled platform extensions (in `extension_data.enabled_extensions.v0`):
`skills`, `analyze`, `developer`, `Extension Manager`, `apps`, `summon`
(subagent delegation), `tom` (injects custom context every turn, via the
`GOOSE_MOIM_MESSAGE_TEXT` / `GOOSE_MOIM_MESSAGE_FILE` environment variables),
and `todo`.

Two cross-vendor facts:

- **goose reads `~/.claude/skills/` as a first-class skill source**, alongside
  `builtin://skills/`, and reports each skill's description and content token
  cost:

  ```
  frontend-design       | 37 desc tokens | 1839 content tokens | ~/.claude/skills/frontend-design
  goose-doc-guide       | 57             | 817                 | builtin://skills/goose-doc-guide
  web-artifacts-builder | 59             | 621                 | ~/.claude/skills/web-artifacts-builder
  web-search            | 47             | 546                 | builtin://skills/web-search
  ```

- **Its provider catalogue wraps other harnesses as providers**: `claude-code`,
  `claude-acp`, `codex`, `codex-acp`, `copilot-acp`, `cursor-agent`,
  `gemini-cli`, `amp-acp`. ACP is both a northbound and a southbound interface
  for goose.

## Design input for OAR

- **A runtime can have a connection layer and still have no cursor.** goose
  mints a connection id per socket, yet `session/load` returns only a
  current-state snapshot. Addressable connection identity and resumable
  position are independent properties; do not infer one from the other.
- **Shared mutable state with per-connection events is the weakest
  multi-observer shape.** Two observers of the same session see each other's
  effects in state but not in events (no mode-change broadcast was observed).
  A host that wants several subscribers to
  agree on an ordering has to append and fan out that ordering itself.
- **Declared capability is a claim to verify, not a contract.** Capability
  negotiation is worth having, and goose's is the most honest of the four samples, yet `session/list` is
  advertised and always empty, and the declared `authMethods` never become an
  auth challenge. A declaration still has to be probed before it is relied on.

## Verification and open gaps

- Not probed: `session/prompt` (needs a real model), `session/delete`, mounting
  `mcpServers` through `session/new`, the real write granularity of `messages`
  and `usage_ledger`, and the semantics of the `recipe` / `schedule` /
  `project` / `parent_session_id` columns.
- No real model turn completed, so frame-level claims about turn content are
  out of scope; only the structural absence of a replayable frame log in the
  inspected storage is established.
