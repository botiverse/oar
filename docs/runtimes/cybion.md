# Cybion

**Community runtime** (`@botiverse/oar/community`), maintained by the adapter's
contributor. Cybion ([cybion.ntnl.io](https://cybion.ntnl.io)) is an agent
harness platform: a **Thread** is a server-side agent conversation that keeps
its own context, Manuals, notes and scheduled checks, and runs its tools on the
owner's registered devices (**Workers**) rather than in the caller's process.

## Native concepts and calling interfaces

Cybion owns four objects this adapter touches:

| Native object | What it is |
|---|---|
| **Thread** | The conversation: model, reasoning effort, loaded Manuals, history, token usage. Persistent and resumable from any client. |
| **Input request** | One user message handed to a Thread. The Thread takes one at a time; a running Thread is `status: running`. |
| **History record** | One append-only row of the Thread (`input`, `response_output`, `tool_output`, `activity`, `checkpoint`). `response_output` payloads are Responses API output items (a message, a reasoning item, a function call). |
| **Worker** | A registered device; the Thread's tools (bash, browser, computer use) run there, not in the OAR host. |

The selected interface is Cybion's **Agent API** (`/v1/threads`), authenticated
with an API key (`Authorization: Bearer cyb_<user id>_<secret>`):

| Call | Meaning |
|---|---|
| `POST /v1/threads` | Create an empty Thread (`title`, `model`, `reasoning_effort`, Manuals, budgets). |
| `GET /v1/threads/{id}` | The Thread view: `status` (`running`/`idle`/`failed`), `display_status` (`ready`/`running`/`compacting`/`completed`/`stopped`/`blocked`/`failed`), usage totals, last context size. |
| `GET /v1/threads/{id}/history` | The whole history, oldest first. |
| `GET /v1/threads/{id}/response` | The latest inference's response snapshot (output items, usage, completion). |
| `POST /v1/threads/{id}/inputs` | Hand one input to the Thread; answers `{thread_id, record_idx, status}`, where `record_idx` is the record the input occupies. Takes `images` as png/jpeg/webp/gif base64 data URLs. |
| `POST /v1/threads/{id}/context` | Append background the integration already holds; starts no turn. |

What the same deployment exposes to its own browser UI but **not** to an API
key: turn cancellation (`POST /api/threads/{id}/cancel`), Thread editing
(model, effort, budget), model listing and account usage. Those are missing
from `external_api` rather than unavailable in Cybion.

## High-level mapping to OAR

| OAR | Cybion |
|---|---|
| `Session.id`, `SessionOptions.resume` | The Thread id. A resumed session is the same conversation, kept by Cybion. |
| `SessionOptions.name` | The Thread title at creation. |
| `SessionOptions.model` / `effort` | `model` / `reasoning_effort` at creation. |
| `prompt` | `POST /v1/threads/{id}/inputs`, then the Thread is followed by polling. |
| `queue` / `withdraw` | Held by the adapter (`queue.durable: false`); sent when the Thread goes idle. |
| `turn_ended` | The Thread's own `status` leaving `running`, read after two quiet polls. |
| `text_delta`, `reasoning`, `tool_call_started`, `tool_call_ended` | One history record each: a `message` item, a `reasoning` item, a function/custom-tool call, its `tool_output`. |
| `user_message` | The Thread's own `input` record (evidence `conversation`). |
| `usage` | The Thread's totals less the ones it carried when the session opened, plus `context_tokens` as context fullness. |
| `abort` | **Refused**: no route exists (see above). |
| `dispose` | Records the release; the Thread outlives the session by design. |

## Capability details

### Creation and resume

`session()` creates an empty Thread, or attaches to an existing id with
`resume`. There is no working directory to carry: the Thread runs on its
owner's Workers, so `cwd` is not transmitted and `additionalDirectories` is
refused rather than ignored. `model` and `effort` are read back from the
Thread; a value that differs from the stored one on resume is refused with an
`UnsupportedOptionError`, because no Agent API route changes either.

### Prompt, steer, queue and cancel

One turn at a time: `prompt` is rejected `busy` while the status fold says
running, matching the contract's invariant by construction. `steer` is absent —
Cybion's Agent API takes no mid-turn input, and its own queue belongs to the
browser's Thread, so a queued input would become a second turn the status
cannot tell from this one. `queue` is therefore held by the adapter and sent
when the Thread idles; `withdraw` exists for the same reason.

`abort` has no native route and answers `unsupported` while a turn runs
(`no_active_turn` when none does). A host that needs to stop a turn does it in
Cybion's own UI. Adding `POST /v1/threads/{id}/cancel` to the Agent API is the
change that would make `abort` real here.

### Events, history and children

Cybion's Agent API streams nothing: a turn is followed by polling
`GET /v1/threads/{id}` (status and usage) and `/history` (records). Every
history record newer than the ones this process already recorded becomes one
frame carrying the record verbatim; the events oar reads out of it are a
projection (`projection.ts`). Because the history is append-only, no record is
recorded twice, and an item whose payload the mapping does not interpret still
enters the stream with its own frame type and no events.

The stream starts at this process's own first turn: a resumed session does not
replay the Thread's earlier records, so `reduceConversation` over a resumed
session shows only what it observed.

A Cybion Thread has no native sub-agents, so `attribution` is `none`: a call the
model makes to another Thread through its own tooling is a tool call, and no
lineage edge is claimed.

### Models, tools and permissions

No `listModels`, no `accountUsage`, no inventory: the Agent API exposes none of
them, and `defineRuntime` answers `unsupported` for the inventories it does not
declare. Tools are Cybion's own (Worker bash, browser, computer use) and are
configured in the deployment, not per session, so `mcpServers`,
`disallowedTools` and `systemPrompt` are refused.

The Thread runs with its owner's configuration: sessions here are not YOLO in
the sense the rest of OAR means, because the caller is not the machine the
tools run on.

### Installation

The adapter is bundled with the host: there is no executable to probe, and
`installation()` answers `{kind: "available", via: "bundled"}` without I/O. The
deployment URL and API key are constructor inputs
(`createCybionRuntime({baseUrl, apiKey})`), so the adapter holds no credential
of its own.

## Evidence and verification

- Native source: Cybion's `src/cloud.rs`, the `external_api` router
  (`/v1/threads`, `/v1/threads/{id}`, `/history`, `/response`, `/inputs`,
  `/context`) and the `history_records` kind constraint
  (`input`, `response_output`, `tool_output`, `checkpoint`, `activity`).
- Tests: `tests/community/cybion/` (the history projection, and a session
  driven against a scripted deployment) run with `OAR_COMMUNITY_TESTS=1`.
  Community tests are outside CI by default, as for every contributor runtime.
- **Wire probe, observed 2026-11-18** (`pnpm tsx
  experiments/cybion-agent-api-probe.ts`): a whole turn driven by this
  repository's own adapter over real HTTP against a local server speaking the
  shapes above — `POST /v1/threads {"title"}` → `GET /{id}/history` →
  `POST /{id}/inputs {"input"}` → polling `GET /{id}` and `/history` — reported
  `turn_started`, `user_message`, `text_delta`, `tool_call_ended`, `usage` and
  a `turn_ended` `completed`, with the Thread's totals (`21`/`6`) and context
  fullness (`23`) read back. So the client, the polled tracker and the session
  lifecycle are exercised end to end over a socket, not only against a stubbed
  `fetch`.
- **Live deployment handshake, observed 2026-11-18** against
  `https://cybion.ntnl.io`: `/health` answers `200`; `POST /v1/threads` without
  a key answers `401 {"error":"Bearer token is required"}`, and with a
  malformed `cyb_` key `401 {"error":"invalid user credential"}`, which the
  adapter surfaces verbatim as the session's error. The route, the auth header
  and the error shape are therefore the real deployment's, not a mock's.
- **Live turn, observed 2026-11-18** against `https://cybion.ntnl.io` with an
  Agent API key: one real turn on a real Thread. `POST /v1/threads` created it,
  the prompt's input record arrived, and the session reported `turn_started`,
  `user_message`, `text_delta` (the model's own answer), `usage` and a
  `turn_ended` `completed`, then went idle with totals
  `{input: 9916, output: 3, cacheRead: 5248}`. The Thread's history held
  exactly the kinds the mapping expects: one `input` (string `content`), two
  `activity` records (`manual_loaded`, which the mapping leaves
  uninterpreted and records as frames with no events), one `request_tail`
  activity, and one `response_output` `message` carrying an `output_text`
  part.
- **Still unexercised live**: `reasoning` items, `function_call` /
  `custom_tool_call` items and `tool_output` records — the observed turn
  answered without tools, so those mappings rest on the source and on the wire
  probe. Unresolved: whether a `blocked` Thread ends its turn as
  `limit_reached` in every case, and whether the Agent API will expose
  cancellation. A session's Thread also outlives it (the Agent API has no
  route that deletes one): a probe leaves a Thread in its owner's list.
