# opencode (investigation)

**Reference only; no OAR adapter.** This page is a live-probe investigation, not
an adapter mapping. It records what was observed on one machine, on one version,
through the runtime's own interfaces.

Evidence baseline: **opencode 1.18.30** (`~/.opencode/bin/opencode`), Linux
x86_64, probed 2026-09-12. Method: headless servers started with
`opencode serve --port 4610/4611/4612`; the machine-readable contract taken from
`GET /doc` (OpenAPI 3.1, 162 paths); every conclusion cross-checked against the
actual rows in `~/.local/share/opencode/opencode.db`. Statements below are
observations unless labelled as a vendor declaration. Version is an evidence
baseline, not a support range. See the [runtime index](../README.md) for status
conventions.

## Native concepts and calling interfaces

opencode is the only sample in this comparison that is **both** a connectable
server and a drivable process, and the only one whose server surface is
self-describing.

| Shape | Command | Protocol |
|---|---|---|
| HTTP server | `opencode serve` | REST + OpenAPI 3.1 self-description (`/doc`), SSE event stream |
| ACP server | `opencode acp` | Agent Client Protocol over stdio |
| Client | `opencode attach <url>` | Connects to someone else's server |
| One-shot | `opencode run` | Single turn |

Its object hierarchy is `project` → `workspace` → `session`:

- `project` is a git worktree; its id is a hash (`/tmp/faye-oc/repo` →
  `5eb21528…`). **Every non-git directory collapses into a single synthetic
  project `global`, with worktree recorded as `/`.** This is easy to misread:
  on one machine all non-repository directories share one project.
- `workspace` (`wrk_` prefix) is a git worktree materialised under
  `~/.local/share/opencode/worktree/<projectID>/<slug>`.
- `session` (`ses_` prefix) carries three attribution columns at once:
  `project_id`, `workspace_id`, `parent_id`.

## Capability details

### Storage: event sourcing and mutable projections in one database

A single SQLite file, `~/.local/share/opencode/opencode.db`, holds 20 tables:
`account`, `account_state`, `control_account`, `credential`, `data_migration`,
`event`, `event_sequence`, `message`, `migration`, `part`, `permission`,
`project`, `project_directory`, `session`, `session_context_epoch`,
`session_input`, `session_message`, `session_share`, `todo`, `workspace`.

The structure that matters: `event` (an immutable stream keyed by
`aggregate_id` + `seq`) plus `event_sequence` (a per-aggregate cursor carrying
an explicit **`owner_id`** column) plus mutable projection tables (`session`,
`message`, `part`, …). The log and the projections live in the same database,
and the projection can be rewritten while the events stay fixed.

### Events and projections disagree, and it is the projection that moves

A session created through the `global` project's server, with
`directory=/tmp/faye-oc/repo`, still carries `"projectID": "global"` in its
immutable seq-0 event today. After another server claimed that directory as a
git project, the `session` **row** was retroactively rewritten to `5eb21528…`.

Methodologically: the persistent log and the projection are two separate
truths and both must be read. Reading only the projection suggests the session
always belonged to that project; reading only the log suggests it never moved.

### Event model: two naming layers, only the persistent one is versioned

- **Bus / HTTP layer — roughly 60 event names, none versioned.** Examples:
  `agent.cycle`, `catalog.updated`, `permission.asked`, `permission.replied`,
  `question.asked`, `pty.created/deleted/exited/updated`, `mcp.tools.changed`,
  `plugin.added`, `session.idle`, `session.error`, `message.part.delta`,
  `session.next.compaction.delta`, `session.next.reasoning.delta`,
  `server.connected`, `global.disposed`, `project.directories.updated`.
- **Persistence / sync layer — 35 types, all suffixed `.N`.** 33 are at `.1`;
  only `session.next.step.ended.2` and `session.next.step.failed.2` have moved
  to `.2`.

opencode therefore treats transient broadcast and replayable persistent events
as two different contracts, and promises version evolution only for the second.
Of the four harnesses surveyed it is the only one that versions events
explicitly.

`/sync/history` cursor semantics (observed): the request body is
`{<aggregateID>: <last seen seq>}` and the response returns events **strictly
greater than** that seq for the named aggregate; **any aggregate not listed is
returned in full from seq 0.** Posting `{"ses_f6ba40976f…":1}` returned only
seq 2 and 3 for that session while five other aggregates came back whole —
consistent with the documented behaviour.

### `/sync/steal` is workspace re-homing, not control preemption

The request shape matters, and getting it wrong is what produced a long run of
`{"_tag":"BadRequest"}`:

```
POST /sync/steal?workspace=wrk_09460c96a0019dGVNJB3IhqUWP
     {"sessionID":"ses_f6ba40976ffeOGfLJoyWTDRJd4"}
→   {"sessionID":"ses_f6ba40976ffeOGfLJoyWTDRJd4"}
```

Omitting `?workspace=` or passing it empty is a `BadRequest`. State difference
before and after, read from the database:

| | before | after |
|---|---|---|
| `session.workspace_id` | empty | `wrk_0946…` |
| `event_sequence.owner_id` | empty | `wrk_0946…` |
| appended `event` | — | one `session.updated.1` per call |

So `steal` re-homes a session onto a workspace: the query parameter names the
target, the body names the session. It emits `session.updated.1`, **not**
`session.next.moved.1` — do not conflate the two. It is **idempotent in state
but not in events**: repeated calls leave the state unchanged while the event
stream keeps growing.

A sharper consequence: **"current workspace" is declared per request by the
client, it is not server state.** The same steal succeeded from a server
started at the repository root (4611) and from one started inside the worktree
(4612); the server's cwd does not participate.

### `/sync/replay` rebuilds a session from its events, and identity is client-declared

Four experiments:

1. Replaying a session's own 4 events verbatim (with `?workspace=`) returned
   **the same** sessionID. That step alone cannot distinguish rebuild from
   no-op.
2. So: `DELETE /session/<id>` first (both the session row and the event rows go
   to zero), then replay its seq-0 event → the session is **fully rebuilt**,
   id, slug and directory all return. Replay is recovery from the log, not a
   no-op.
3. Rewriting `aggregateID` / `sessionID` / the event `id` in the payload to a
   fresh `ses_` returned the new id and produced **an entirely new session** in
   the database — same slug, same directory, a clone.
4. Posting the same payload twice left a single seq-0 row: **event-level
   idempotent** (the opposite of `steal`).

Conclusion: **sessionID is declared by the client inside the event; the server
does not mint it.** `?workspace=` only sets `event_sequence.owner_id`; the
session row's `workspace_id` / `project_id` / `directory` are all restored from
the event payload, never from the query parameter. This makes "move a session
to another machine or another workspace" protocol-feasible — at the cost of
session identity having no server-side authority: whoever can write events can
declare identity. On this machine the server ran with `OPENCODE_SERVER_PASSWORD`
unset, i.e. unauthenticated, by default.

Two API traps: `/sync/history` returns `aggregate_id` (snake_case) while
`/sync/replay` requires `aggregateID` (camelCase), so a round-trip must rename
the field; and a replay missing `?workspace=` reports `500 UnknownError` with an
`err_<id>` reference rather than `400`.

### Where `parent_id` comes from

- **Only** `POST /session {"parentID":"ses_…"}` writes `parent_id`. It appears
  in `/children` immediately.
- **Fork does not write `parent_id`**: after a fork, `/children` returns `[]` —
  while `/children`'s own documentation describes "child sessions that were
  **forked** from the specified parent". Documentation and implementation
  disagree; that mismatch is itself a finding.
- `POST /api/session` is a second session-creation endpoint whose schema has no
  `parentID` at all. Passing it neither errors nor takes effect, despite the
  schema declaring `additionalProperties: false`. Unknown fields are silently
  swallowed.
- Related schema surface: `subagent`, `subagent_depth`,
  `/experimental/session/{id}/background`.

### Attribution compared with the other samples

- **Claude Code**: runtime process identity `(pidDomain, pid, procStart)` plus a
  peer socket registry — attribution is bound to a **living process**.
- **Codex**: `installation_id` plus `[projects."<absolute path>"].trust_level` —
  attribution is bound to a **disk path**.
- **opencode**: workspace scope, rewritable by events, with a literal `owner_id`
  column on the event stream — attribution is **first-class, movable data**.

## Design input for OAR

- **A log and a projection are two truths, and reading one is not reading the
  other.** opencode keeps both in the same database and lets the projection be
  rewritten under a fixed log. Any host that consumes a runtime's stored state
  has to say which of the two it read.
- **Identity written by the client has no server authority.** Because a session
  id arrives inside the replayed event, whoever can write events can declare
  identity. This is what makes cross-machine session movement feasible here, and
  it is also why a host cannot inherit the runtime's identity as its own: OAR's
  lineage has to record the requests OAR itself issued.
- **Versioning only the persistent layer is a deliberate, copyable split.**
  opencode leaves ~60 bus event names unversioned and suffixes all 35 persistent
  types with `.N`. Transient broadcast and replayable record are different
  contracts and only the second needs to promise evolution.

## Verification and open gaps

- **Blocked, not explained.** `POST /experimental/workspace {"type":"worktree"}`
  returns `{"name":"WorkspaceCreateError","data":{"message":"Timed out waiting
  for global event"}}` **while the database row and the on-disk git worktree are
  both created successfully**. So this is a post-creation wait timeout — most
  likely waiting on a server instance or sync loop inside the new worktree — not
  a creation failure. Stranger: `GET /experimental/workspace` and
  `/experimental/workspace/status` still return `[]` when the row exists. The
  server log printed only the unset-password warning, and the `err_<id>` detail
  never reaches stdout, so this could not be localised further. Recorded as a
  blocker rather than resolved by reading source.
- Two adjacent facts observed while cleaning up: calling create twice leaves
  **two workspace rows pointing at the same directory**; and
  `DELETE /experimental/workspace/{id}` removes the database row, the on-disk
  git worktree and the git registration, but **leaves the `project_directory`
  row pointing at the now-missing directory** — another projection that did not
  keep up.
- Not probed: `/api/session/{id}/event`, `/event`,
  `/experimental/session/{id}/background`, `/api/pty/*`, `/mcp/*`,
  `/permission`, `project.sandboxes`, `session_context_epoch`.
- No real model turns were run, so message/part write granularity is
  unmeasured.
